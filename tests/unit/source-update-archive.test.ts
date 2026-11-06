import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fixture, direct, copyUpdateModules, moduleRoot, makeJob, startSnapshotWorker, ownChild, stopFixtureRuntime } from "../helpers/source-update/fixture.ts";
import { atomicJson } from "../../src/update/state-store.ts";
import { waitFor } from "../../src/update/worker.ts";
import { Repository } from "../../src/update/repository.ts";
import { runProcess } from "../../src/update/process.ts";
import { archiveObjects, gitObjectId, githubArchiveTransport, reconstructCommit } from "../../src/update/github-archive.ts";

// Real Git objects/archives, mocked HTTPS only. No real upstream is changed.
async function archiveFixture(t: test.TestContext, merge = false, runtime = false) {
  const f = await fixture(); t.after(f.cleanup);
  const commits = new Map<string, unknown>(), archives = new Map<string, Buffer>();
  const remember = async (sha: string) => {
    const raw = await f.git("cat-file", "commit", sha);
    const person = (line: string) => {
      const match = /^(?:author|committer) (.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line)!;
      return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
    };
    const [header, ...message] = raw.split("\n\n");
    const lines = header!.split("\n");
    commits.set(sha, { sha, tree: { sha: lines[0]!.slice(5) },
      parents: lines.filter(l => l.startsWith("parent ")).map(l => ({ sha: l.slice(7) })),
      author: person(lines.find(l => l.startsWith("author "))!), committer: person(lines.find(l => l.startsWith("committer "))!),
      message: message.join("\n\n"), verification: {} });
    const file = path.join(f.parent, `${sha}.tgz`);
    await f.git("archive", "--format=tar.gz", "--prefix=Ant-Code-fixture/", `--output=${file}`, sha);
    archives.set(sha, await fs.readFile(file));
  };
  await f.put("first.txt", "first snapshot"); const first = await f.commit("first"); await remember(first);
  await f.put("binary.dat", "\0binary\u00ff\n"); await f.put("nested/second.txt", "second snapshot");
  if (runtime) {
    await copyUpdateModules(path.join(f.root, "src/update"), true);
    await f.put("src/cli/index.ts", await fs.readFile(path.join(moduleRoot, "tests/helpers/source-update/new-runtime.ts"), "utf8"));
  }
  let target = await f.commit("second"); await remember(target);
  if (merge) {
    await f.git("checkout", "-b", "side", f.head);
    await f.put("side.txt", "side history"); const side = await f.commit("side"); await remember(side);
    await f.git("checkout", "main"); await f.git("merge", "--no-ff", "-m", "merge side", "side");
    target = await f.git("rev-parse", "HEAD"); await remember(target);
  }
  // Clone while only the base branch is referenced; --no-local prevents copying
  // unreachable target objects. Source retains those objects for mock responses.
  await f.git("checkout", "--detach", f.head); await f.git("branch", "-f", "main", f.head);
  const root = path.join(f.parent, "installation");
  assert.equal((await runProcess("git", ["clone", "--no-local", "--single-branch", "--branch", "main", f.root, root], { cwd: f.parent, env: f.env })).code, 0);
  const git = async (...args: string[]) => {
    const r = await runProcess("git", args, { cwd: root, env: f.env });
    assert.equal(r.code, 0, r.stderr); return r.stdout.trim();
  };
  await git("remote", "set-url", "origin", "https://github.com/wicm84266964/Ant-Code.git");
  assert.notEqual((await runProcess("git", ["cat-file", "-e", target], { cwd: root, env: f.env })).code, 0);
  let reads = 0;
  t.mock.method(githubArchiveTransport, "read", async (url: string) => {
    reads++;
    if (url.endsWith("/commits/main")) return Buffer.from(JSON.stringify({ sha: target }));
    const sha = url.split("/").at(-1)!;
    if (url.startsWith("https://api.github.com/repos/wicm84266964/Ant-Code/git/commits/") && commits.has(sha)) return Buffer.from(JSON.stringify(commits.get(sha)));
    if (url.startsWith("https://codeload.github.com/wicm84266964/Ant-Code/tar.gz/") && archives.has(sha)) return archives.get(sha)!;
    throw new Error("Unexpected URL");
  });
  const repo = new Repository(root, f.env, async (file, args, options) => {
    if (args.includes("fetch")) return { code: 128, stdout: "", stderr: "simulated network failure" };
    return runProcess(file, args, options);
  });
  return { f, root, target, first, repo, git, archives, commits, reads: () => reads };
}

test("archive fallback imports missing history; real Git export/FF/fsck and retry remain valid", async t => {
  const f = await archiveFixture(t);
  const plan = await f.repo.check(direct);
  assert.equal(plan.target, f.target); assert.equal(plan.transport, "codeload");
  assert.equal(await f.git("rev-parse", "HEAD"), f.f.head);
  assert.equal(await f.git("status", "--porcelain"), "");
  await f.git("fsck", "--full", "--no-dangling");
  const candidate = path.join(f.f.parent, "candidate");
  await f.repo.exportCandidate(plan, candidate, path.join(f.f.parent, "candidate-index"));
  assert.equal(await fs.readFile(path.join(candidate, "nested/second.txt"), "utf8"), "second snapshot");
  assert.equal((await f.repo.check(direct)).target, f.target);
  await f.repo.fastForward(plan);
  assert.equal(await f.git("rev-parse", "HEAD"), f.target);
  await f.git("fsck", "--full", "--no-dangling");
});

test("failed archive validation leaves HEAD/files/dependencies unchanged and can retry", async t => {
  const f = await archiveFixture(t);
  const original = f.archives.get(f.first)!;
  f.archives.set(f.first, f.archives.get(f.target)!);
  await fs.mkdir(path.join(f.root, "node_modules"));
  await fs.writeFile(path.join(f.root, "node_modules", "keep"), "old dependencies");
  await assert.rejects(f.repo.check(direct), { code: "ARCHIVE_TREE_MISMATCH" });
  assert.equal(await f.git("rev-parse", "HEAD"), f.f.head);
  assert.equal(await f.git("status", "--porcelain"), "");
  assert.equal(await fs.readFile(path.join(f.root, "node_modules/keep"), "utf8"), "old dependencies");
  assert.notEqual((await runProcess("git", ["cat-file", "-e", f.target], { cwd: f.root, env: f.f.env })).code, 0);
  f.archives.set(f.first, original);
  assert.equal((await f.repo.check(direct)).target, f.target);
  await f.git("fsck", "--full", "--no-dangling");
});

test("archive plan completes detached dependency preparation, FF, strict restart and new-instance ACK", { timeout: 60_000 }, async t => {
  const f = await archiveFixture(t, false, true);
  const plan = await f.repo.check(direct);
  const old = spawn(process.execPath, ["-e", "const s=require('node:http').createServer((q,r)=>r.end('old'));s.listen(0,'127.0.0.1',()=>console.log(s.address().port))"], {
    stdio: ["ignore", "pipe", "ignore"], windowsHide: true
  });
  const owned = ownChild(old); f.f.own(owned.stop);
  const listening = once(old.stdout, "data", { signal: AbortSignal.timeout(5000) });
  await once(old, "spawn"); const [data] = await listening;
  const port = Number(data.toString().trim()); assert.ok(port > 0);
  const { store, journal } = await makeJob({ ...f.f, root: f.root, plan: () => plan }, plan.target, old.pid!);
  journal.restart.port = port; await store.writeJournal(journal);
  f.f.own(() => stopFixtureRuntime(store, journal));
  const worker = await startSnapshotWorker(store, journal, f.f.env); f.f.own(worker.stop);
  await waitFor(async () => (await store.journal(journal.jobId))?.step === "prepared", 25_000);
  assert.equal(await f.git("rev-parse", "HEAD"), f.f.head);
  await atomicJson(path.join(store.jobDirectory(journal.jobId), "handoff.json"), { nonce: journal.nonce });
  await waitFor(async () => (await store.journal(journal.jobId))?.step === "awaitingExit", 5000);
  await owned.stop();
  assert.equal(await worker.exited, 0, worker.stderr());
  const result = await store.journal(journal.jobId);
  assert.equal(result?.phase, "succeeded", JSON.stringify(result));
  assert.equal(result?.step, "acknowledged");
  assert.equal(result?.plan.transport, "codeload");
  assert.equal(await f.git("rev-parse", "HEAD"), f.target);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(3000) })).text(), "fixture");
  await f.git("fsck", "--full", "--no-dangling");
});

test("proxy failures and local dirty state never invoke direct archive fallback", async t => {
  const f = await archiveFixture(t);
  await assert.rejects(f.repo.check({ mode: "proxy", source: "manual", url: "http://localhost:12345" }), { code: "GIT_FAILED" });
  assert.equal(f.reads(), 0);
  await fs.writeFile(path.join(f.root, "private.txt"), "preserve");
  await assert.rejects(f.repo.check(direct), { code: "DIRTY_WORKTREE" });
  assert.equal(f.reads(), 0);
});

test("merge history survives interruption during commit publication and retry", async t => {
  const f = await archiveFixture(t, true);
  const link = fs.link;
  let interrupt = true;
  t.mock.method(fs, "link", async (source: string, destination: string) => {
    if (interrupt && destination === path.join(f.root, ".git/objects", f.target.slice(0, 2), f.target.slice(2))) {
      interrupt = false; throw new Error("simulated disk failure publishing tip");
    }
    return link(source, destination);
  });
  await assert.rejects(f.repo.check(direct), /simulated disk failure/);
  assert.equal(await f.git("rev-parse", "HEAD"), f.f.head);
  // All visible commit objects must have complete ancestors/trees, even when
  // interrupted before the tip was published.
  await f.git("fsck", "--full", "--no-dangling");
  const plan = await f.repo.check(direct);
  assert.equal(plan.target, f.target);
  assert.equal((await f.git("rev-list", "--parents", "-1", f.target)).split(" ").length, 3);
  await f.repo.fastForward(plan);
  assert.equal(await fs.readFile(path.join(f.root, "side.txt"), "utf8"), "side history");
  await f.git("fsck", "--full", "--no-dangling");
});

test("archive content/hash and tar safety checks reject corruption, traversal and links", async t => {
  const f = await archiveFixture(t);
  const archive = f.archives.get(f.target)!;
  const tree = (f.commits.get(f.target) as any).tree.sha;
  assert.ok(archiveObjects(archive, tree).size > 0);
  assert.throws(() => archiveObjects(archive, "0".repeat(40)), { code: "ARCHIVE_TREE_MISMATCH" });
  assert.throws(() => archiveObjects(Buffer.from("bad gzip"), tree), { code: "ARCHIVE_INVALID" });
  const rewrite = (name: string, type = "0") => {
    const tar = gunzipSync(archive);
    // First header is Git global pax; edit the following header.
    const size = parseInt(tar.subarray(124, 136).toString().replace(/\0/g, "").trim(), 8);
    const offset = 512 + Math.ceil(size / 512) * 512;
    tar.fill(0, offset, offset + 100); tar.write(name, offset);
    tar.write(type, offset + 156); tar.fill(32, offset + 148, offset + 156);
    let sum = 0; for (const b of tar.subarray(offset, offset + 512)) sum += b;
    tar.write(sum.toString(8).padStart(6, "0") + "\0 ", offset + 148);
    return gzipSync(tar);
  };
  assert.throws(() => archiveObjects(rewrite("../escape"), tree), { code: "UNSAFE_TARGET_PATH" });
  assert.throws(() => archiveObjects(rewrite("fixture/link", "2"), tree), { code: "UNSUPPORTED_TREE_ENTRY" });
});

test("signed commit is accepted only when exact bytes hash to advertised SHA", () => {
  const payload = `tree ${"1".repeat(40)}\nauthor A <a@example.invalid> 1 +0000\ncommitter A <a@example.invalid> 1 +0000\n\nmessage\n`;
  const signature = "-----BEGIN PGP SIGNATURE-----\nfixture\n-----END PGP SIGNATURE-----\n";
  const split = payload.indexOf("\n\n");
  const raw = Buffer.from(payload.slice(0, split) + "\ngpgsig " + signature.replaceAll("\n", "\n ") + payload.slice(split));
  const metadata = { sha: gitObjectId("commit", raw), verification: { payload, signature } };
  assert.deepEqual(reconstructCommit(metadata), raw);
  assert.throws(() => reconstructCommit({ ...metadata, sha: "0".repeat(40) }), { code: "ARCHIVE_COMMIT_UNSUPPORTED" });
});

test("transport rejects nonofficial endpoints before connecting", async () => {
  for (const url of ["http://api.github.com/", "https://github.com/", "https://api.github.com.evil/", "https://user:secret@api.github.com/"]) {
    await assert.rejects(async () => githubArchiveTransport.read(url, 1024, AbortSignal.timeout(100)), { code: "ARCHIVE_URL_INVALID" });
  }
});
