import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { discoverRoute, normalizeUpdateProxy, parseWindowsStaticProxy, summarizeRoute, redactUpdateText } from "../../src/update/proxy-policy.ts";
import { findNpmCli, routedEnvironment, runProcess } from "../../src/update/process.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { fixture, makeJob, direct } from "../helpers/source-update/fixture.ts";
import { runUpdateWorker } from "../../src/update/worker.ts";
import type { Runner } from "../../src/update/process.ts";

test("manual/config/env/discovered proxy precedence and explicit one-shot direct", async () => {
  const base = { root: process.cwd(), env: { HTTPS_PROXY: "http://127.0.0.1:41329" }, config: { web: { proxyUrl: "http://127.0.0.1:45678" } } };
  assert.equal((await discoverRoute(base)).source, "config");
  assert.equal((await discoverRoute({ ...base, proxyUrl: "localhost:43127" })).source, "manual");
  assert.equal((await discoverRoute({ ...base, config: {} })).source, "env:HTTPS_PROXY");
  assert.deepEqual(await discoverRoute({ ...base, allowDirect: true }), { mode: "direct", source: "explicit" });
  await assert.rejects(discoverRoute({ ...base, proxyUrl: "bad", allowDirect: true }), /AMBIGUOUS_ROUTE/);
  assert.throws(() => normalizeUpdateProxy("socks5://127.0.0.1:9876"), /Only HTTP/);
  assert.throws(() => normalizeUpdateProxy("http://host:1234/path"), /INVALID_PROXY/);
});
test("actual configured Git/npm/Windows ports only; PAC and absent route fail closed", async () => {
  let git = "", npm = "", registry = "";
  const runner: Runner = async (file, args) => {
    if (file === "git") return { code: 0, stdout: git, stderr: "" };
    if (file === "reg.exe") return { code: 0, stdout: registry, stderr: "" };
    return { code: 0, stdout: args.at(-1) === "https-proxy" ? npm : "null", stderr: "" };
  };
  const options = { root: process.cwd(), env: {}, runner, platform: "win32" as const };
  git = "http.proxy\nhttp://127.0.0.1:53281\0";
  assert.equal((await discoverRoute(options)).source, "git");
  git = ""; npm = "http://localhost:49153";
  assert.equal((await discoverRoute(options)).source, "npm:https-proxy");
  npm = "null"; registry = "ProxyEnable    REG_DWORD    0x1\nProxyServer REG_SZ http=127.0.0.1:52014;https=127.0.0.1:53282\n";
  const route = await discoverRoute(options);
  assert.equal(route.source, "windows"); assert.equal(route.mode === "proxy" && route.url, "http://127.0.0.1:53282/");
  assert.equal(parseWindowsStaticProxy(registry), "127.0.0.1:53282");
  registry = "AutoConfigURL REG_SZ https://example.invalid/proxy.pac";
  await assert.rejects(discoverRoute(options), /PAC cannot/);
  registry = ""; await assert.rejects(discoverRoute(options), /No supported proxy/);
});
test("Git/npm receive one route with credentials off argv and summaries; hostile bypass environment removed", () => {
  const route = { mode: "proxy", source: "manual", url: "http://person:topsecret@127.0.0.1:51239/" } as const;
  const input = { NO_PROXY: "*", no_proxy: "github.com", HTTPS_PROXY: "http://wrong:80", NPM_CONFIG_PROXY: "http://wrong:81", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.proxy", NODE_TLS_REJECT_UNAUTHORIZED: "0", NODE_OPTIONS: "--require bad" };
  const git = routedEnvironment(input, route, "git"), npm = routedEnvironment(input, route, "npm");
  assert.equal(git.HTTPS_PROXY, route.url); assert.equal(npm.HTTPS_PROXY, route.url);
  assert.equal(git.NO_PROXY, ""); assert.equal(npm.no_proxy, "");
  assert.equal(npm.npm_config_https_proxy, route.url); assert.equal(npm.npm_config_strict_ssl, "true");
  assert.equal(npm.npm_config_noproxy, ",");
  assert.equal(npm.npm_config_registry, "https://registry.npmjs.org/"); assert.equal(npm.npm_config_replace_registry_host, "never");
  assert.equal(git.NODE_TLS_REJECT_UNAUTHORIZED, undefined); assert.equal(git.NODE_OPTIONS, undefined);
  assert.equal(npm.NPM_CONFIG_PROXY, undefined);
  assert.ok(!JSON.stringify(summarizeRoute(route)).includes("topsecret"));
  assert.ok(!redactUpdateText(`fetch ${route.url}`).includes("topsecret"));
  assert.equal(routedEnvironment(input, { mode: "direct", source: "explicit" }, "git").HTTPS_PROXY, "");
});
test("real npm discovery reads original config; worker ci isolates conflicting npmrc and keeps HTTPS lock route", { timeout: 35_000 }, async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  let directHttp = 0, proxyHttp = 0;
  const destinations: string[] = [];
  const trap = http.createServer((_req, res) => { directHttp++; res.writeHead(502); res.end(); });
  trap.listen(0, "127.0.0.1"); await once(trap, "listening");
  t.after(() => new Promise<void>((resolve) => trap.close(() => resolve())));
  const proxy = http.createServer((_req, res) => { proxyHttp++; res.writeHead(502); res.end(); });
  proxy.on("connect", (req, socket) => { destinations.push(req.url ?? ""); socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"); });
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  t.after(() => new Promise<void>((resolve) => proxy.close(() => resolve())));
  const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/`;
  const hostile = `registry=http://127.0.0.1:${(trap.address() as { port: number }).port}/\nreplace-registry-host=always\nnoproxy=*\nproxy=${url}\nhttps-proxy=${url}\n`;
  const user = path.join(f.parent, "home", ".npmrc"), global = path.join(f.parent, "global.npmrc");
  await fs.writeFile(user, hostile); await fs.writeFile(global, hostile);
  const env = { ...f.env, npm_config_userconfig: user, NPM_CONFIG_GLOBALCONFIG: global };
  const route = await discoverRoute({ root: f.root, env });
  assert.deepEqual(route, { mode: "proxy", source: "npm:https-proxy", url });
  const resolved = "https://npm-source-update.invalid/transport-fixture-1.0.0.tgz";
  const target = await f.advance({
    "package.json": JSON.stringify({ name: "@ant-code/cli", version: "0.0.1", engines: { node: ">=22.18" }, dependencies: { "transport-fixture": "1.0.0" } }),
    "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: {
      "": { name: "@ant-code/cli", version: "0.0.1", dependencies: { "transport-fixture": "1.0.0" } },
      "node_modules/transport-fixture": { version: "1.0.0", resolved, integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==" }
    } })
  });
  const { store, journal } = await makeJob(f, target, process.pid);
  let installs = 0;
  await runUpdateWorker(store, journal, route, env, { runner: async (file, args, options) => {
    if (args.includes("ci")) {
      installs++; assert.equal(options.timeoutMs, 10 * 60_000, "worker install timeout is preserved");
      for (const key of ["npm_config_userconfig", "npm_config_globalconfig"]) {
        const config = options.env[key]!;
        assert.equal(path.dirname(config), store.jobDirectory(journal.jobId));
        assert.equal(await fs.readFile(config, "utf8"), "");
      }
      // Retries/disk cache are fixture-only controls. The actual npm ci executes.
      return runProcess(file, [...args, "--fetch-retries=0", "--fetch-timeout=5000", `--cache=${path.join(f.parent, "cache")}`], { ...options, timeoutMs: 10_000 });
    }
    return runProcess(file, args, options);
  } });
  assert.equal(installs, 1);
  assert.equal((await store.journal(journal.jobId))?.error, "CANDIDATE_INSTALL_FAILED");
  assert.deepEqual(destinations, ["npm-source-update.invalid:443"], "locked HTTPS target must tunnel through selected proxy");
  assert.equal(proxyHttp, 0, "no registry HTTP downgrade through proxy");
  assert.equal(directHttp, 0, "no direct HTTP registry access");
  assert.equal(await fs.readFile(user, "utf8"), hostile); assert.equal(await fs.readFile(global, "utf8"), hostile);
});
test("real npm honors nonempty noproxy and explicit direct overrides file proxies", { timeout: 20_000 }, async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  let contacts = 0;
  const proxy = http.createServer((_req, res) => { contacts++; res.writeHead(502); res.end(); });
  proxy.on("connect", (_req, socket) => { contacts++; socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"); });
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  t.after(() => new Promise<void>((resolve) => proxy.close(() => resolve())));
  const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/`;
  const config = `proxy=${url}\nhttps-proxy=${url}\nnoproxy=*\nregistry=http://registry-conflict.invalid/\nreplace-registry-host=always\n`;
  const user = path.join(f.parent, "user.npmrc"), global = path.join(f.parent, "global.npmrc");
  await fs.writeFile(user, config); await fs.writeFile(global, config);
  const npm = await findNpmCli();
  const envFor = (route: Parameters<typeof routedEnvironment>[1]) => ({
    ...routedEnvironment({ ...f.env, PROXY: url }, route, "npm"), npm_config_userconfig: user, npm_config_globalconfig: global
  });
  const env = envFor({ mode: "proxy", source: "manual", url });
  for (const [key, expected] of [["registry", "https://registry.npmjs.org/"], ["replace-registry-host", "never"], ["noproxy", ","]]) {
    const result = await runProcess(process.execPath, [npm, "config", "get", key], { cwd: f.root, env, timeoutMs: 5000 });
    assert.equal(result.code, 0); assert.equal(result.stdout.trim(), expected);
  }
  const args = [npm, "ping", "--registry=https://npm-source-update.invalid/", "--fetch-retries=0", "--fetch-timeout=3000"];
  assert.notEqual((await runProcess(process.execPath, args, { cwd: f.root, env, timeoutMs: 7000 })).code, 0);
  assert.equal(contacts, 1, "noproxy=* in files cannot bypass selected proxy");
  const directEnv = envFor(direct);
  for (const key of ["proxy", "https-proxy"]) {
    const result = await runProcess(process.execPath, [npm, "config", "get", key], { cwd: f.root, env: directEnv, timeoutMs: 5000 });
    assert.equal(result.code, 0); assert.equal(result.stdout.trim(), "false");
  }
  assert.notEqual((await runProcess(process.execPath, args, { cwd: f.root, env: directEnv, timeoutMs: 7000 })).code, 0);
  assert.equal(contacts, 1, "explicit direct clears file proxies and bare PROXY env");
  assert.equal(await fs.readFile(user, "utf8"), config); assert.equal(await fs.readFile(global, "utf8"), config);
});
test("real Git CONNECT and Node npm-cli both use a random actual proxy; failure never silently retries direct", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const proxy = http.createServer((_req, res) => { res.writeHead(502); res.end(); });
  let connects = 0;
  proxy.on("connect", (_req, socket) => { connects++; socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"); });
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  t.after(() => new Promise<void>((resolve) => proxy.close(() => resolve())));
  const port = (proxy.address() as { port: number }).port;
  const route = { mode: "proxy", source: "manual", url: `http://127.0.0.1:${port}/` } as const;
  // .invalid means even an accidental direct path cannot touch the public network.
  const git = await runProcess("git", ["ls-remote", "https://git-source-update.invalid/repo.git"], {
    cwd: f.root, env: routedEnvironment({ ...f.env, NO_PROXY: "*" }, route, "git"), timeoutMs: 10_000
  });
  assert.notEqual(git.code, 0); assert.equal(connects, 1);
  const npm = await findNpmCli(); assert.ok(npm.endsWith("npm-cli.js"));
  const result = await runProcess(process.execPath, [npm, "ping", "--registry=https://npm-source-update.invalid/", "--fetch-retries=0"], {
    cwd: f.root, env: routedEnvironment({ ...f.env, NO_PROXY: "*" }, route, "npm"), timeoutMs: 10_000
  });
  assert.notEqual(result.code, 0); assert.ok(connects >= 2);
});
