import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { verifyDashboardAssets } from "../../scripts/dashboard-assets.js";
import { collectLockfileConsistencyFailures } from "../../scripts/lockfile-consistency.js";
import { collectLocalTestFiles, sanitizedTestEnvironment } from "../../scripts/run-tests.js";
import { compareTypeDiagnosticCounts, parseTypeScriptDiagnostics } from "../../scripts/type-ratchet.js";

test("dashboard asset gate rejects stale bundles and font manifest drift", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-asset-gate-"));
  const committedVendorDir = path.join(root, "vendor");
  await fs.cp("src/dashboard/public/vendor", committedVendorDir, { recursive: true });
  await fs.appendFile(path.join(committedVendorDir, "rich-renderers.js"), "\n// stale\n", "utf8");
  await fs.appendFile(path.join(committedVendorDir, "katex.min.css"), "\n/* stale */\n", "utf8");
  await fs.rm(path.join(committedVendorDir, "fonts", "KaTeX_AMS-Regular.woff2"));
  await fs.writeFile(path.join(committedVendorDir, "fonts", "stale-font.woff2"), "stale", "utf8");

  await assert.rejects(
    verifyDashboardAssets({ committedVendorDir }),
    (error) => {
      assert.match(error.message, /stale committed asset: rich-renderers\.js/);
      assert.match(error.message, /stale committed asset: katex\.min\.css/);
      assert.match(error.message, /missing committed asset: fonts\/KaTeX_AMS-Regular\.woff2/);
      assert.match(error.message, /unexpected committed asset: fonts\/stale-font\.woff2/);
      return true;
    }
  );
});

test("dependency gate rejects any package lock and shrinkwrap difference", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-lock-gate-"));
  await fs.writeFile(path.join(root, "package-lock.json"), "{\n  \"lockfileVersion\": 3\n}\n", "utf8");
  await fs.writeFile(path.join(root, "npm-shrinkwrap.json"), "{\n  \"lockfileVersion\": 3\n}\n", "utf8");

  assert.deepEqual(await collectLockfileConsistencyFailures(root), []);
  await fs.appendFile(path.join(root, "npm-shrinkwrap.json"), "\n", "utf8");
  assert.deepEqual(await collectLockfileConsistencyFailures(root), [
    "npm-shrinkwrap.json must match package-lock.json exactly"
  ]);
});

test("type ratchet fails on a real new checkJs diagnostic and allows reductions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-type-gate-"));
  await fs.writeFile(path.join(root, "bad.js"), "/** @type {string} */\nconst value = 42;\n", "utf8");
  await fs.writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      allowJs: true,
      checkJs: true,
      noEmit: true,
      strict: true,
      types: []
    },
    include: ["bad.js"]
  }), "utf8");

  const compiler = path.resolve("node_modules", "typescript", "bin", "tsc");
  const result = spawnSync(process.execPath, [compiler, "--noEmit", "--project", "tsconfig.json", "--pretty", "false"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true
  });
  assert.notEqual(result.status, 0);

  const parsed = parseTypeScriptDiagnostics(`${result.stdout}\n${result.stderr}`, root);
  assert.deepEqual(parsed.diagnostics, [{ file: "bad.js", code: "TS2322" }]);
  const added = compareTypeDiagnosticCounts({}, { "bad.js": { TS2322: 1 } });
  assert.deepEqual(added.failures, ["bad.js TS2322: 1 diagnostics (baseline allows 0)"]);

  const reduced = compareTypeDiagnosticCounts({ "bad.js": { TS2322: 2 } }, { "bad.js": { TS2322: 1 } });
  assert.deepEqual(reduced.failures, []);
  assert.equal(reduced.reductions, 1);
});

test("Windows executable build runs the asset gate before cleaning build output", async () => {
  const source = await fs.readFile("scripts/build-windows-exe.js", "utf8");
  const preflight = source.indexOf("await verifyDashboardAssets");
  const firstReleaseRemoval = source.indexOf("await fs.rm(RELEASE");

  assert.ok(preflight >= 0);
  assert.ok(firstReleaseRemoval > preflight);
});

test("npm check orders type, unit, browser, asset, and diff gates", async () => {
  const pkg = JSON.parse(await fs.readFile("package.json", "utf8"));
  assert.equal(pkg.scripts.test, "node scripts/run-tests.js");
  assert.equal(pkg.scripts["test:dashboard:browser"], "node --test tests/browser/dashboard-browser.test.js");
  const check = pkg.scripts.check;
  const stages = ["check:types", "npm test", "test:dashboard:browser", "check:dashboard-assets", "check:diff"];

  let previous = -1;
  for (const stage of stages) {
    const current = check.indexOf(stage);
    assert.ok(current > previous, `${stage} must follow the preceding gate`);
    previous = current;
  }
});

test("local test discovery excludes the separately gated browser suite", async () => {
  const files = await collectLocalTestFiles();
  assert.ok(files.includes(path.join("tests", "unit", "dashboard-release-gates.test.js")));
  assert.ok(files.some((file) => file.startsWith(path.join("tests", "integration") + path.sep)));
  assert.equal(files.some((file) => file.startsWith(path.join("tests", "browser") + path.sep)), false);
});

test("local test runner removes live Ant Code model settings from child processes", () => {
  const source = {
    PATH: "kept",
    CI: "true",
    ANT_CODE_BROWSER_DEPENDENCY_ROOT: "kept-for-separate-browser-gate",
    LAB_AGENT_MODEL: "external-model",
    LAB_AGENT_MODELS: "external-a,external-b",
    LAB_MODEL_GATEWAY_URL: "https://live-gateway.example",
    ANTCODE_CONTROL_CONFIG: "live-control.json",
    ANT_CODE_DASHBOARD_ACTIVE_SESSION_MAX: "999"
  };

  assert.deepEqual(sanitizedTestEnvironment(source), {
    PATH: "kept",
    CI: "true",
    ANT_CODE_BROWSER_DEPENDENCY_ROOT: "kept-for-separate-browser-gate"
  });
  assert.deepEqual(sanitizedTestEnvironment(source, "isolated-home"), {
    PATH: "kept",
    CI: "true",
    ANT_CODE_BROWSER_DEPENDENCY_ROOT: "kept-for-separate-browser-gate",
    HOME: "isolated-home",
    USERPROFILE: "isolated-home"
  });
});
