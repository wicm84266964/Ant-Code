import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { UpdateError } from "./contracts.ts";
import type { RepositoryIdentity, Route, UpdatePlan } from "./contracts.ts";
import { cleanEnvironment, routedEnvironment, runProcess } from "./process.ts";
import type { Runner } from "./process.ts";

export async function sourceRootFromModule(moduleUrl = import.meta.url): Promise<string> {
  return fs.realpath(path.resolve(path.dirname(fileURLToPath(moduleUrl)), "../.."));
}
export function isOfficialUpstream(value: string): boolean {
  return /^https:\/\/github\.com\/wicm84266964\/ant-code(?:\.git)?$/i.test(value);
}
export function assertSafeGitConfig(text: string) {
  for (const entry of text.split("\0")) {
    const at = entry.indexOf("\n"); if (at < 0) continue;
    const key = entry.slice(0, at).toLowerCase();
    const value = entry.slice(at + 1);
    if (/^(url\..*\.(insteadof|pushinsteadof)|include\.|includeif\.|filter\.|credential\.|diff\..*\.(command|textconv)|merge\..*\.driver|alias\.|submodule\.)/.test(key) ||
      /^(core\.(hookspath|fsmonitor|sshcommand|gitproxy|alternaterefscommand|askpass|editor|pager)|ssh\.variant|gpg\.|http\..*extraheader|http\.extraheader|http\..*ssl|http\.ssl|http\..*followredirects|http\.followredirects)/.test(key) ||
      /^(pager\.|sequence\.editor$|interactive\.difffilter$|diff\.external$|sendemail\.smtpserver$|gc\.recentobjectshook$|uploadpack\.packobjectshook$)/.test(key) ||
      /^remote\..*\.(uploadpack|receivepack|vcs|proxy|promisor|partialclonefilter)$/.test(key) ||
      /^extensions\.(worktreeconfig|partialclone)$/.test(key) ||
      (/^http\..*\.proxy$/.test(key) && key !== "http.proxy") ||
      (key === "core.bare" && value === "true")) {
      throw new UpdateError("UNSAFE_GIT_CONFIG", "Unsupported Git execution, rewrite, TLS, URL-scoped routing or partial-clone configuration.");
    }
  }
}
export function validateDependencyLock(lock: unknown) {
  const data = lock as { lockfileVersion?: number; packages?: Record<string, { resolved?: string; integrity?: string; link?: boolean }> };
  if (!data || ![2, 3].includes(data.lockfileVersion ?? 0) || !data.packages || typeof data.packages !== "object") throw new UpdateError("UNSUPPORTED_LOCKFILE");
  for (const [name, pkg] of Object.entries(data.packages)) {
    if (!name) continue;
    // Forbid Git/file dependencies: they can execute helpers or bypass the chosen HTTP route.
    if (!name.startsWith("node_modules/") || pkg.link || !pkg.resolved || !pkg.integrity) throw new UpdateError("UNSAFE_DEPENDENCY");
    let url: URL;
    try { url = new URL(pkg.resolved); } catch { throw new UpdateError("UNSAFE_DEPENDENCY"); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new UpdateError("UNSAFE_DEPENDENCY");
  }
}
export class Repository {
  root: string; env: NodeJS.ProcessEnv; runner: Runner;
  constructor(root: string, env: NodeJS.ProcessEnv = process.env, runner: Runner = runProcess) {
    this.root = root; this.env = env; this.runner = runner;
  }
  async git(args: string[], route?: Route, extra: NodeJS.ProcessEnv = {}) {
    // Local-only operations get the same command-execution protections, without network permission.
    const env = { ...routedEnvironment(this.env, route ?? { mode: "direct", source: "explicit" }, "git"), ...extra };
    const result = await this.runner("git", args, { cwd: this.root, env, timeoutMs: route ? 90_000 : 30_000 });
    if (result.code !== 0) throw new UpdateError("GIT_FAILED", "Git operation failed (output withheld to protect credentials).");
    return result.stdout;
  }
  async inspect(): Promise<RepositoryIdentity> {
    this.root = await fs.realpath(this.root);
    const gitDir = await fs.lstat(path.join(this.root, ".git")).catch(() => null);
    if (!gitDir?.isDirectory() || gitDir.isSymbolicLink()) throw new UpdateError("SOURCE_INSTALL_REQUIRED", "Only standalone source clones are supported; linked worktrees and packaged installs are not.");
    const raw = await this.runner("git", ["config", "--null", "--list"], { cwd: this.root, env: cleanEnvironment(this.env) });
    if (raw.code !== 0) throw new UpdateError("GIT_CONFIG_UNREADABLE");
    assertSafeGitConfig(raw.stdout);
    // Alternates can make fetch consult external object stores and execute alternateRefsCommand.
    // Reject the files themselves (also symlinks/empty files) before any object/ref operation.
    for (const name of ["objects/info/alternates", "objects/info/http-alternates"]) {
      if (await fs.lstat(path.join(this.root, ".git", name)).then(() => true, () => false)) throw new UpdateError("ALTERNATE_OBJECT_STORE_UNSUPPORTED");
    }
    const top = (await this.git(["rev-parse", "--show-toplevel"])).trim();
    if (await fs.realpath(top) !== this.root) throw new UpdateError("NOT_SOURCE_ROOT");
    for (const name of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_START", "index.lock", "shallow", "info/grafts"]) {
      if (await fs.lstat(path.join(this.root, ".git", name)).then(() => true, () => false)) throw new UpdateError("GIT_OPERATION_IN_PROGRESS");
    }
    if ((await this.git(["for-each-ref", "--format=%(refname)", "refs/replace/"])).trim()) throw new UpdateError("REPLACE_REFS_UNSUPPORTED");
    const branch = (await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
    const head = (await this.git(["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    if (!branch || !/^[a-f0-9]{40,64}$/.test(head)) throw new UpdateError("DETACHED_OR_INVALID_HEAD");
    const remote = (await this.git(["config", "--get", `branch.${branch}.remote`])).trim();
    const mergeRef = (await this.git(["config", "--get", `branch.${branch}.merge`])).trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(remote) || !/^refs\/heads\/[^\s\0]+$/.test(mergeRef)) throw new UpdateError("UNSAFE_UPSTREAM");
    const urls = (await this.git(["config", "--get-all", `remote.${remote}.url`])).trim().split("\n");
    if (urls.length !== 1 || !isOfficialUpstream(urls[0])) throw new UpdateError("UNSUPPORTED_UPSTREAM", "Current upstream must be the official public HTTPS repository.");
    await this.assertClean();
    return { root: this.root, head, branch, remote, mergeRef, upstreamUrl: urls[0] };
  }
  async assertClean() {
    if ((await this.git(["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"])).length) throw new UpdateError("DIRTY_WORKTREE");
    const flags = await this.git(["ls-files", "-v", "-z"]);
    if (flags.split("\0").some((item) => item && item[0] !== "H")) throw new UpdateError("HIDDEN_INDEX_CHANGES", "skip-worktree/assume-unchanged/sparse entries are unsupported.");
    const dependencies = await fs.lstat(path.join(this.root, "node_modules")).catch(() => null);
    if (dependencies && (!dependencies.isDirectory() || dependencies.isSymbolicLink())) throw new UpdateError("UNSAFE_DEPENDENCIES");
  }
  async check(route: Route): Promise<UpdatePlan> {
    const identity = await this.inspect();
    // Fetch a literal trusted URL and current upstream ref, never a config refspec or remote helper.
    await this.git(["-c", "fetch.writeCommitGraph=false", "fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", identity.upstreamUrl, identity.mergeRef], route);
    // --no-write-fetch-head does not expose the fetched tip; resolve it via ls-remote over the SAME route.
    const refs = await this.git(["ls-remote", "--exit-code", identity.upstreamUrl, identity.mergeRef], route);
    const target = refs.trim().split(/\s+/)[0];
    if (!/^[a-f0-9]{40,64}$/.test(target)) throw new UpdateError("INVALID_TARGET");
    // If upstream moved between fetch and ls-remote, fail closed rather than fetch an arbitrary SHA.
    await this.git(["cat-file", "-e", `${target}^{commit}`]);
    await this.git(["merge-base", "--is-ancestor", identity.head, target]);
    await this.validateTarget(target);
    const fresh = await this.inspect();
    if (JSON.stringify(fresh) !== JSON.stringify(identity)) throw new UpdateError("REPOSITORY_CHANGED");
    const now = Date.now();
    return { ...identity, id: randomUUID(), target, createdAt: now, expiresAt: now + 10 * 60_000 };
  }
  async validateTarget(target: string) {
    const entries = (await this.git(["ls-tree", "-r", "-z", target])).split("\0").filter(Boolean);
    const tracked = new Set((await this.git(["ls-files", "-z"])).split("\0"));
    const ignored = (await this.git(["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ".", ":(exclude)node_modules"])).split("\0").filter(Boolean);
    const names = new Set<string>();
    for (const entry of entries) {
      const at = entry.indexOf("\t"), file = entry.slice(at + 1), mode = entry.slice(0, 6);
      if (at < 0 || !["100644", "100755"].includes(mode)) throw new UpdateError("UNSUPPORTED_TREE_ENTRY", "Symlinks/submodules in candidate source are unsupported.");
      const lower = file.toLowerCase();
      if (file.split("/").some((p) => !p || p === ".." || p === "." || /^(\.git|node_modules)$/i.test(p) || /[\\:\x00-\x1f]/.test(p) || /[. ]$/.test(p)) || names.has(lower)) throw new UpdateError("UNSAFE_TARGET_PATH");
      names.add(lower);
      if (ignored.some((p) => p.toLowerCase() === lower || p.toLowerCase().startsWith(`${lower}/`) || lower.startsWith(`${p.toLowerCase()}/`))) throw new UpdateError("IGNORED_COLLISION");
      // Also catch ignored directories and platform aliases absent from ls-files output.
      if (!tracked.has(file) && await fs.lstat(path.join(this.root, file)).then(() => true, () => false)) throw new UpdateError("UNTRACKED_COLLISION");
    }
    for (const required of ["package.json", "package-lock.json", "src/cli/index.ts", "src/dashboard/public/index.html", "src/dashboard/public/app.js"]) {
      if (!names.has(required)) throw new UpdateError("MISSING_CANDIDATE_RESOURCE");
    }
    const pkg = JSON.parse(await this.git(["show", `${target}:package.json`])) as { name?: string; engines?: { node?: string } };
    if (pkg.name !== "@ant-code/cli" || !pkg.engines?.node) throw new UpdateError("UNSUPPORTED_PACKAGE");
    // Git tree pathspecs are case-sensitive even on Windows; npm's filesystem is not.
    if (names.has(".npmrc")) throw new UpdateError("UNSUPPORTED_NPM_CONFIG", "Candidate .npmrc requires manual review.");
    const locks = ["package-lock.json"];
    if (names.has("npm-shrinkwrap.json")) locks.push("npm-shrinkwrap.json");
    for (const file of locks) validateDependencyLock(JSON.parse(await this.git(["show", `${target}:${file}`])));
  }
  async revalidate(plan: UpdatePlan) {
    const fresh = await this.inspect();
    for (const key of ["root", "head", "branch", "remote", "mergeRef", "upstreamUrl"] as const) {
      if (fresh[key] !== plan[key]) throw new UpdateError("PLAN_STALE");
    }
    await this.git(["merge-base", "--is-ancestor", plan.head, plan.target]);
    await this.validateTarget(plan.target);
  }
  async exportCandidate(plan: UpdatePlan, directory: string, indexFile: string) {
    await fs.mkdir(directory, { recursive: false, mode: 0o700 });
    const extra = { GIT_INDEX_FILE: indexFile };
    await this.git(["read-tree", plan.target], undefined, extra);
    await this.git(["checkout-index", "--all", `--prefix=${directory.replaceAll("\\", "/")}/`], undefined, extra);
    await fs.rm(indexFile, { force: true });
  }
  async fastForward(plan: UpdatePlan) {
    await this.revalidate(plan);
    await this.git(["merge", "--ff-only", "--no-edit", "--no-stat", "--no-overwrite-ignore", plan.target]);
    if ((await this.git(["rev-parse", "HEAD"])).trim() !== plan.target) throw new UpdateError("WRONG_APPLIED_COMMIT");
  }
}
