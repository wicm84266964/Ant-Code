import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const RELEASE = path.join(DIST, "ant-code-windows-x64");
const BUILD = path.join(DIST, "exe-build");
const BUNDLE = path.join(BUILD, "ant-code.bundle.mjs");
const BOOTSTRAP = path.join(BUILD, "sea-bootstrap.cjs");
const SEA_CONFIG = path.join(BUILD, "sea-config.json");
const SEA_BLOB = path.join(BUILD, "ant-code.blob");
const EXE = path.join(RELEASE, "ant-code.exe");
const NODE_EXE = process.execPath;

const RESOURCE_PATHS = [
  "README.md",
  "README.zh-CN.md",
  "lab-agent.config.json",
  "configure-gateway.ps1",
  "configure-gateway.cmd",
  "package.json",
  "config/lab-agent.high-sensitivity-template.json",
  "config/lab-agent.lab-template.json",
  "config/skills",
  "src/dashboard/public",
  "docs/audit",
  "docs/branding",
  "docs/deployment",
  "docs/provenance",
  "docs/security",
  "docs/specs/lab-model-gateway-compatibility-matrix.md",
  "docs/specs/lab-model-gateway-protocol.md",
  "docs/specs/tool-and-permission-spec.md"
];

await fs.rm(RELEASE, { recursive: true, force: true });
await fs.rm(BUILD, { recursive: true, force: true });
await fs.mkdir(RELEASE, { recursive: true });
await fs.mkdir(BUILD, { recursive: true });

await build({
  entryPoints: [path.join(ROOT, "src", "cli", "index.js")],
  outfile: BUNDLE,
  bundle: true,
  platform: "node",
  format: "esm",
  target: ["node20"],
  banner: {
    js: "import { createRequire as __antCodeCreateRequire } from 'node:module'; const require = __antCodeCreateRequire(import.meta.url);"
  },
  define: {
    "process.env.NODE_ENV": "\"production\"",
    "process.env.DEV": "\"false\""
  },
  plugins: [ignoreInkDevtoolsPlugin()],
  minify: true,
  legalComments: "none",
  logLevel: "silent"
});

await fs.writeFile(BOOTSTRAP, [
  "const { getAsset } = require('node:sea');",
  "const { writeFileSync } = require('node:fs');",
  "const { join } = require('node:path');",
  "const { pathToFileURL } = require('node:url');",
  "process.env.LAB_AGENT_PACKAGE_ROOT = process.env.LAB_AGENT_PACKAGE_ROOT || require('node:path').dirname(process.execPath);",
  "const bundle = getAsset('ant-code.bundle.mjs', 'utf8');",
  "const bundlePath = join(require('node:os').tmpdir(), `ant-code-sea-${process.pid}.mjs`);",
  "writeFileSync(bundlePath, bundle, 'utf8');",
  "import(pathToFileURL(bundlePath).href).catch((error) => {",
  "  console.error(error && error.stack ? error.stack : error);",
  "  process.exitCode = 1;",
  "});",
  ""
].join("\n"));

await fs.writeFile(SEA_CONFIG, JSON.stringify({
  main: BOOTSTRAP,
  output: SEA_BLOB,
  assets: {
    "ant-code.bundle.mjs": BUNDLE
  },
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: true
}, null, 2));

run(NODE_EXE, ["--experimental-sea-config", SEA_CONFIG], ROOT);
await fs.copyFile(NODE_EXE, EXE);
run(process.execPath, [
  path.join(ROOT, "node_modules", "postject", "dist", "cli.js"),
  EXE,
  "NODE_SEA_BLOB",
  SEA_BLOB,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"
], ROOT);

for (const relativePath of RESOURCE_PATHS) {
  await copyResource(relativePath);
}

await writeLauncher("ant-code.cmd", "ant-code.exe");
await writeLauncher("lab-agent.cmd", "ant-code.exe");

const sha256 = await sha256File(EXE);
const manifest = [
  "# Ant Code Windows x64 Executable",
  "",
  `Built: ${new Date().toISOString()}`,
  `Node runtime: ${process.version}`,
  `Executable: ant-code.exe`,
  `SHA256: ${sha256}`,
  "",
  "This external package is the Windows executable distribution. It includes",
  "a bundled runtime executable plus configuration templates, deployment docs,",
  "skills, and audit evidence. It does not include the repository src/ tree,",
  "tests, npm tarball, node_modules, local sessions, logs, or temporary files.",
  "",
  "Run:",
  "",
  "```powershell",
  ".\\ant-code.exe --version",
  ".\\ant-code.exe doctor",
  "```",
  ""
].join("\n");
await fs.writeFile(path.join(RELEASE, "RELEASE-MANIFEST.md"), manifest);

console.log(`Windows executable release written to ${RELEASE}`);
console.log(`SHA256 ${sha256}`);

async function copyResource(relativePath) {
  const source = path.join(ROOT, relativePath);
  const destination = path.join(RELEASE, relativePath);
  const stat = await fs.stat(source).catch(() => null);
  if (!stat) {
    return;
  }
  if (stat.isDirectory()) {
    await copyDirectory(source, destination);
    return;
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

function ignoreInkDevtoolsPlugin() {
  return {
    name: "ignore-ink-devtools",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /(^|\/|\\)devtools\.js$/ }, (args) => {
        if (args.importer && /node_modules[\\/]+ink[\\/]+build[\\/]+reconciler\.js$/.test(args.importer)) {
          return { path: "ink-devtools-empty", namespace: "ant-code-empty" };
        }
        return null;
      });
      pluginBuild.onLoad({ filter: /.*/, namespace: "ant-code-empty" }, () => ({
        contents: "export default {};",
        loader: "js"
      }));
    }
  };
}

async function copyDirectory(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(from, to);
    } else if (entry.isFile()) {
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(from, to);
    }
  }
}

async function writeLauncher(name, target) {
  const content = `@echo off\r\n\"%~dp0${target}\" %*\r\n`;
  await fs.writeFile(path.join(RELEASE, name), content);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const file = await fs.open(filePath, "r");
  try {
    for await (const chunk of file.readableWebStream({ type: "bytes" })) {
      hash.update(Buffer.from(chunk));
    }
  } finally {
    await file.close();
  }
  return hash.digest("hex").toUpperCase();
}
