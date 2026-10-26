import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { Repository, isOfficialUpstream, assertSafeGitConfig, validateDependencyLock } from "../../src/update/repository.ts";
import { fixture, direct } from "../helpers/source-update/fixture.ts";
import { runProcess } from "../../src/update/process.ts";

for (const value of ["https://github.com/wicm84266964/Ant-Code.git", "https://GITHUB.COM/WICM84266964/ant-code"]) {
  test(`official HTTPS allowlist: ${value}`, () => assert.equal(isOfficialUpstream(value), true));
}
for (const value of ["http://github.com/wicm84266964/Ant-Code.git", "https://user@github.com/wicm84266964/Ant-Code.git", "git@github.com:wicm84266964/Ant-Code.git", "https://github.com/wicm84266964/Ant-Code.git/", "https://github.com.evil/wicm84266964/Ant-Code"]) {
  test(`reject unsupported upstream ${value}`, () => assert.equal(isOfficialUpstream(value), false));
}
for (const key of ["url.https://evil.insteadof", "core.hookspath", "core.fsmonitor", "filter.bad.smudge", "credential.helper", "http.https://github.com.proxy", "http.sslverify", "remote.origin.uploadpack", "merge.bad.driver", "include.path", "extensions.worktreeconfig"]) {
  test(`dangerous Git config rejected: ${key}`, () => assert.throws(() => assertSafeGitConfig(`${key}\nvalue\0`), /Unsupported Git/));
}
test("other executable Git config is rejected conservatively", () => {
  for (const key of ["core.alternateRefsCommand", "core.askPass", "core.editor", "core.pager", "pager.log", "sequence.editor", "interactive.diffFilter", "diff.external", "gpg.ssh.program", "gc.recentObjectsHook", "uploadpack.packObjectsHook", "sendemail.smtpServer"]) {
    assert.throws(() => assertSafeGitConfig(`${key}\ncommand\0`), { code: "UNSAFE_GIT_CONFIG" }, key);
  }
});
test("real Git alternate command and object stores are rejected before fetch without executing command", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const other = path.join(f.parent, "alternate repo");
  assert.equal((await runProcess("git", ["clone", "--bare", "--local", f.root, other], { cwd: f.parent, env: f.env })).code, 0);
  const info = path.join(f.root, ".git", "objects", "info");
  await fs.writeFile(path.join(info, "alternates"), `${path.join(other, "objects").replaceAll("\\", "/")}\n`);
  // Outside the worktree: an executed command cannot just trip the dirty-tree guard.
  const marker = path.join(f.parent, "alternate-command-executed");
  await f.git("config", "core.alternateRefsCommand", `echo executed > '${marker.replaceAll("\\", "/")}'`);
  let calls = 0;
  const repo = new Repository(f.root, f.env, async (file, args, options) => {
    calls++; assert.ok(!args.includes("fetch"), "must reject before transport");
    assert.deepEqual(args, ["config", "--null", "--list"], "reject before any ref/object operation");
    return runProcess(file, args, options);
  });
  await assert.rejects(repo.check(direct), { code: "UNSAFE_GIT_CONFIG" });
  assert.equal(calls, 1);
  await f.git("config", "--unset", "core.alternateRefsCommand");
  calls = 0;
  await assert.rejects(repo.check(direct), { code: "ALTERNATE_OBJECT_STORE_UNSUPPORTED" });
  assert.equal(calls, 1);
  await fs.rename(path.join(info, "alternates"), path.join(info, "http-alternates"));
  await assert.rejects(repo.check(direct), { code: "ALTERNATE_OBJECT_STORE_UNSUPPORTED" });
  assert.equal(await fs.stat(marker).then(() => true, () => false), false);
});
test("lockfiles cannot spawn Git/file helpers or hide local links", () => {
  for (const resolved of ["git+https://github.com/some/pkg", "file:../pkg", "http://registry.invalid/pkg.tgz", "https://user:secret@registry.invalid/pkg.tgz"]) {
    assert.throws(() => validateDependencyLock({ lockfileVersion: 3, packages: { "node_modules/a": { resolved, integrity: "sha512-fixture" } } }));
  }
  validateDependencyLock({ lockfileVersion: 3, packages: { "": {}, "node_modules/a": { resolved: "https://registry.invalid/a.tgz", integrity: "sha512-fixture" } } });
});
test("case-aliased candidate npm config is rejected before install on every platform", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const target = await f.advance({ ".NPMRC": "registry=https://example.invalid/\n" });
  await assert.rejects(new Repository(f.root, f.env).validateTarget(target), { code: "UNSUPPORTED_NPM_CONFIG" });
});

test("real isolated Git: current branch FF plan, isolated export, FF apply and noop", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const target = await f.advance();
  const repo = new Repository(f.root, f.env, f.runner(target));
  const plan = await repo.check(direct);
  assert.equal(plan.head, f.head); assert.equal(plan.target, target);
  assert.equal(await f.git("rev-parse", "HEAD"), f.head);
  const candidate = path.join(f.parent, "candidate");
  await repo.exportCandidate(plan, candidate, path.join(f.parent, "index"));
  assert.equal(await fs.readFile(path.join(candidate, "feature.txt"), "utf8"), "candidate");
  assert.equal(await f.git("status", "--porcelain"), "");
  await repo.fastForward(plan);
  assert.equal(await f.git("rev-parse", "HEAD"), target);
  assert.equal((await repo.check(direct)).target, target);
});
test("real Git dirty/untracked/hidden index and ongoing-operation guards", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const repo = new Repository(f.root, f.env);
  await f.put("untracked.txt", "do not touch");
  await assert.rejects(repo.inspect(), /DIRTY_WORKTREE/);
  await fs.unlink(path.join(f.root, "untracked.txt"));
  await f.git("update-index", "--assume-unchanged", "package.json");
  await assert.rejects(repo.inspect(), /skip-worktree/);
  await f.git("update-index", "--no-assume-unchanged", "package.json");
  await fs.writeFile(path.join(f.root, ".git", "MERGE_HEAD"), f.head);
  await assert.rejects(repo.inspect(), /GIT_OPERATION_IN_PROGRESS/);
});
test("real Git ignored files are preserved and block candidate collision", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  await f.put("ignored/user.txt", "candidate");
  await f.git("add", "-f", "ignored/user.txt");
  const target = await f.commit("tracked ignored path");
  await f.git("checkout", "-b", "base", f.head);
  await f.git("config", "branch.base.remote", "origin"); await f.git("config", "branch.base.merge", "refs/heads/main");
  await f.put("ignored/user.txt", "private user data");
  const repo = new Repository(f.root, f.env, f.runner(target));
  await assert.rejects(repo.check(direct), /IGNORED_COLLISION/);
  assert.equal(await fs.readFile(path.join(f.root, "ignored/user.txt"), "utf8"), "private user data");
});
test("real Git merge refuses an ignored private file created AFTER revalidation", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  await f.put("ignored/late.txt", "candidate"); await f.git("add", "-f", "ignored/late.txt");
  const target = await f.commit("candidate tracks ignored path");
  await f.git("checkout", "-b", "base", f.head);
  await f.git("config", "branch.base.remote", "origin"); await f.git("config", "branch.base.merge", "refs/heads/main");
  let injected = false;
  const repo = new Repository(f.root, f.env, async (file, args, options) => {
    if (args[0] === "merge") {
      assert.equal(injected, false); injected = true;
      assert.ok(args.includes("--no-overwrite-ignore"));
      await f.put("ignored/late.txt", "late private data");
    }
    return f.runner(target)(file, args, options);
  });
  const plan = await repo.check(direct); // no collision exists while planning/revalidating
  await assert.rejects(repo.fastForward(plan), { code: "GIT_FAILED" });
  assert.equal(injected, true);
  assert.equal(await f.git("rev-parse", "HEAD"), f.head);
  assert.equal(await fs.readFile(path.join(f.root, "ignored/late.txt"), "utf8"), "late private data");
});
test("real Git divergence and stale plan cannot be applied", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const target = await f.advance();
  const repo = new Repository(f.root, f.env, f.runner(target));
  const plan = await repo.check(direct);
  await f.put("local.txt", "local commit"); await f.commit("local");
  await assert.rejects(repo.revalidate(plan), /PLAN_STALE/);
  await assert.rejects(repo.check(direct), /Git operation failed/);
  assert.equal(await fs.readFile(path.join(f.root, "local.txt"), "utf8"), "local commit");
});
test("real Git remote/config/detached safety before network fetch", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const repo = new Repository(f.root, f.env, async (file, args, options) => {
    assert.ok(!args.includes("fetch")); return (await import("../../src/update/process.ts")).runProcess(file, args, options);
  });
  await f.git("remote", "set-url", "origin", "https://example.invalid/not-official");
  await assert.rejects(repo.check(direct), /official public HTTPS/);
  await f.git("remote", "set-url", "origin", "https://github.com/wicm84266964/Ant-Code.git");
  await f.git("config", "url.https://example.invalid/.insteadOf", "https://github.com/");
  await assert.rejects(repo.inspect(), /Unsupported Git/);
  await f.git("config", "--unset", "url.https://example.invalid/.insteadOf");
  await f.git("checkout", "--detach");
  await assert.rejects(repo.inspect(), /Git operation failed/);
});
