// Official HTTPS archive fallback. Import content-addressed Git objects only;
// installation still uses Repository.validateTarget/revalidate/fastForward.
import https from "node:https";
import { rootCertificates } from "node:tls";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync, deflateSync, inflateSync } from "node:zlib";
import { UpdateError } from "./contracts.ts";

const API = "https://api.github.com/repos/wicm84266964/Ant-Code";
const DOWNLOAD = "https://codeload.github.com/wicm84266964/Ant-Code/tar.gz/";
const shaPattern = /^[a-f0-9]{40}$/;
type GitObject = { type: "commit" | "tree" | "blob"; data: Buffer };
export const githubArchiveTransport = {
  read(url: string, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !["api.github.com", "codeload.github.com"].includes(parsed.hostname)
      || parsed.username || parsed.password || parsed.port || parsed.hash) throw new UpdateError("ARCHIVE_URL_INVALID");
    return new Promise((resolve, reject) => {
      // A fresh agent and built-in HTTPS ignore proxy/CA injection environment.
      // Only used after explicitly choosing direct; never as proxy failover.
      const agent = new https.Agent({ keepAlive: false });
      const timer = setTimeout(() => request.destroy(new UpdateError("ARCHIVE_NETWORK_FAILED")), 20_000);
      const request = https.get(parsed, {
        agent, signal, rejectUnauthorized: true, ca: [...rootCertificates],
        headers: { "user-agent": "Ant-Code-source-updater", accept: "application/vnd.github+json", "accept-encoding": "identity" }
      }, response => {
        if (response.statusCode !== 200) {
          response.destroy();
          request.destroy(new UpdateError(response.statusCode === 403 || response.statusCode === 429 ? "ARCHIVE_RATE_LIMITED" : "ARCHIVE_NETWORK_FAILED"));
          return;
        }
        let bytes = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes) { request.destroy(new UpdateError("ARCHIVE_LIMIT")); return; }
          chunks.push(chunk);
        });
        response.once("error", () => request.destroy(new UpdateError("ARCHIVE_NETWORK_FAILED")));
        response.once("end", () => { clearTimeout(timer); agent.destroy(); resolve(Buffer.concat(chunks)); });
      });
      request.once("error", error => {
        clearTimeout(timer); agent.destroy();
        reject(error instanceof UpdateError ? error : new UpdateError("ARCHIVE_NETWORK_FAILED"));
      });
    });
  }
};

export function gitObjectId(type: GitObject["type"], data: Buffer): string {
  return createHash("sha1").update(`${type} ${data.length}\0`).update(data).digest("hex");
}
function validSha(value: unknown): string {
  if (typeof value !== "string" || !shaPattern.test(value)) throw new UpdateError("ARCHIVE_METADATA_INVALID");
  return value;
}
function json(bytes: Buffer): any {
  try { return JSON.parse(bytes.toString("utf8")); } catch { throw new UpdateError("ARCHIVE_METADATA_INVALID"); }
}

// Signed commits expose their exact signed payload. Unsigned commits expose UTC
// dates, so reconstruct common Git timezone encodings and accept only an exact
// object hash match. Unrepresentable/custom commit headers fail closed.
export function reconstructCommit(commit: any): Buffer {
  const sha = validSha(commit?.sha);
  if (commit?.verification?.payload && commit?.verification?.signature) {
    const payload = String(commit.verification.payload), signature = String(commit.verification.signature);
    const split = payload.indexOf("\n\n");
    if (split < 0) throw new UpdateError("ARCHIVE_COMMIT_UNSUPPORTED");
    for (const sig of [signature, signature.trimEnd()]) {
      const raw = Buffer.from(`${payload.slice(0, split)}\ngpgsig ${sig.replaceAll("\n", "\n ")}${payload.slice(split)}`);
      if (gitObjectId("commit", raw) === sha) return raw;
    }
  } else {
    const identity = (person: any) => {
      if (!person || typeof person.name !== "string" || typeof person.email !== "string"
        || /[\r\n<>\0]/.test(person.name + person.email)) throw new UpdateError("ARCHIVE_COMMIT_UNSUPPORTED");
      const timestamp = Date.parse(person.date);
      if (!Number.isFinite(timestamp)) throw new UpdateError("ARCHIVE_COMMIT_UNSUPPORTED");
      return `${person.name} <${person.email}> ${Math.floor(timestamp / 1000)}`;
    };
    if (!Array.isArray(commit.parents) || commit.parents.length > 16 || typeof commit.message !== "string") throw new UpdateError("ARCHIVE_METADATA_INVALID");
    if (Buffer.byteLength(commit.message) > 64 * 1024) throw new UpdateError("ARCHIVE_COMMIT_UNSUPPORTED");
    const prefix = `tree ${validSha(commit.tree?.sha)}\n${commit.parents.map((p: any) => `parent ${validSha(p.sha)}\n`).join("")}`;
    const author = identity(commit.author), committer = identity(commit.committer);
    const offsets = ["+0000", "-0000"];
    for (let minutes = -12 * 60; minutes <= 14 * 60; minutes += 15) {
      const absolute = Math.abs(minutes);
      offsets.push(`${minutes < 0 ? "-" : "+"}${String(Math.floor(absolute / 60)).padStart(2, "0")}${String(absolute % 60).padStart(2, "0")}`);
    }
    for (const a of offsets) for (const c of offsets) for (const tail of ["", "\n"]) {
      const raw = Buffer.from(`${prefix}author ${author} ${a}\ncommitter ${committer} ${c}\n\n${commit.message}${tail}`);
      if (gitObjectId("commit", raw) === sha) return raw;
    }
  }
  throw new UpdateError("ARCHIVE_COMMIT_UNSUPPORTED");
}

function pax(data: Buffer): Record<string, string> {
  const result: Record<string, string> = {};
  for (let offset = 0; offset < data.length;) {
    const space = data.indexOf(32, offset);
    const lengthText = data.subarray(offset, space).toString();
    if (space < 0 || !/^[0-9]+$/.test(lengthText)) throw new UpdateError("ARCHIVE_INVALID");
    const length = Number(lengthText);
    if (length <= space - offset + 1 || offset + length > data.length || data[offset + length - 1] !== 10) throw new UpdateError("ARCHIVE_INVALID");
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const equal = record.indexOf("=");
    if (equal < 1) throw new UpdateError("ARCHIVE_INVALID");
    result[record.slice(0, equal)] = record.slice(equal + 1);
    offset += length;
  }
  return result;
}

export function archiveObjects(compressed: Buffer, expectedTree: string): Map<string, GitObject> {
  validSha(expectedTree);
  let tar: Buffer;
  try { tar = gunzipSync(compressed, { maxOutputLength: 128 * 1024 * 1024 }); }
  catch { throw new UpdateError("ARCHIVE_INVALID"); }
  type Entry = { mode: string; id: string; children?: Map<string, Entry> };
  const root: Entry = { mode: "40000", id: "", children: new Map() };
  const objects = new Map<string, GitObject>();
  const add = (type: GitObject["type"], data: Buffer) => {
    const id = gitObjectId(type, data); objects.set(id, { type, data }); return id;
  };
  const field = (header: Buffer, start: number, length: number) => {
    const bytes = header.subarray(start, start + length), end = bytes.indexOf(0);
    const slice = end < 0 ? bytes : bytes.subarray(0, end), text = slice.toString("utf8");
    if (!Buffer.from(text).equals(slice)) throw new UpdateError("ARCHIVE_INVALID");
    return text;
  };
  const octal = (text: string) => {
    if (!/^[0-7]+$/.test(text.trim())) throw new UpdateError("ARCHIVE_INVALID");
    return parseInt(text.trim(), 8);
  };
  let prefix = "", nextPax: Record<string, string> = {}, ended = false, entries = 0;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (tar.length - offset < 1024 || !tar.subarray(offset).every(byte => byte === 0)) throw new UpdateError("ARCHIVE_INVALID");
      ended = true; break;
    }
    let sum = 0;
    for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 32 : header[index]!;
    if (sum !== octal(field(header, 148, 8))) throw new UpdateError("ARCHIVE_INVALID");
    const size = octal(field(header, 124, 12)), mode = octal(field(header, 100, 8));
    if (!Number.isSafeInteger(size) || offset + 512 + size > tar.length || size > 32 * 1024 * 1024) throw new UpdateError("ARCHIVE_LIMIT");
    const data = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    const type = field(header, 156, 1);
    if (type === "g") {
      if (Object.keys(pax(data)).some(key => !["comment", "mtime", "atime", "ctime"].includes(key))) throw new UpdateError("ARCHIVE_INVALID");
      continue;
    }
    if (type === "x") { if (Object.keys(nextPax).length) throw new UpdateError("ARCHIVE_INVALID"); nextPax = pax(data); continue; }
    if (!["", "0", "5"].includes(type) || field(header, 157, 100)) throw new UpdateError("UNSUPPORTED_TREE_ENTRY");
    if (Object.keys(nextPax).some(key => !["path", "mtime", "atime", "ctime"].includes(key))) throw new UpdateError("ARCHIVE_INVALID");
    const name = nextPax.path ?? [field(header, 345, 155), field(header, 0, 100)].filter(Boolean).join("/");
    nextPax = {};
    const parts = name.replace(/\/$/, "").split("/");
    if (parts.some(p => !p || p === "." || p === ".." || /[\\:\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(\.git|node_modules)$/i.test(p))) throw new UpdateError("UNSAFE_TARGET_PATH");
    if (!prefix) prefix = parts[0]!;
    if (parts.shift() !== prefix || (parts.length === 0 && type !== "5")) throw new UpdateError("ARCHIVE_INVALID");
    if (++entries > 20_000) throw new UpdateError("ARCHIVE_LIMIT");
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      const existing = directory.children!.get(part);
      if (existing && !existing.children) throw new UpdateError("ARCHIVE_INVALID");
      if (!existing) directory.children!.set(part, { mode: "40000", id: "", children: new Map() });
      directory = directory.children!.get(part)!;
    }
    if (parts.length === 0) continue;
    const leaf = parts.at(-1)!;
    if (type === "5") {
      if (size !== 0) throw new UpdateError("ARCHIVE_INVALID");
      const existing = directory.children!.get(leaf);
      if (existing && !existing.children) throw new UpdateError("ARCHIVE_INVALID");
      if (!existing) directory.children!.set(leaf, { mode: "40000", id: "", children: new Map() });
    } else {
      if (directory.children!.has(leaf)) throw new UpdateError("ARCHIVE_INVALID");
      directory.children!.set(leaf, { mode: mode & 0o111 ? "100755" : "100644", id: add("blob", data) });
    }
  }
  if (!ended || Object.keys(nextPax).length) throw new UpdateError("ARCHIVE_INVALID");
  const tree = (directory: Entry): string => {
    const entries = [...directory.children!.entries()].sort(([a, av], [b, bv]) => Buffer.compare(Buffer.from(a + (av.children ? "/" : "")), Buffer.from(b + (bv.children ? "/" : ""))));
    return add("tree", Buffer.concat(entries.map(([name, entry]) => Buffer.concat([
      Buffer.from(`${entry.mode} ${name}\0`), Buffer.from(entry.children ? tree(entry) : entry.id, "hex")
    ]))));
  };
  if (tree(root) !== expectedTree) throw new UpdateError("ARCHIVE_TREE_MISMATCH");
  return objects;
}

async function storeObject(root: string, id: string, object: GitObject) {
  const base = await fs.realpath(path.join(root, ".git", "objects"));
  if (base !== path.join(await fs.realpath(root), ".git", "objects")) throw new UpdateError("ARCHIVE_OBJECT_STORE_UNSAFE");
  const directory = path.join(base, id.slice(0, 2));
  await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  if (await fs.realpath(directory) !== directory) throw new UpdateError("ARCHIVE_OBJECT_STORE_UNSAFE");
  const destination = path.join(directory, id.slice(2));
  const temporary = path.join(directory, `tmp_archive_${randomUUID()}`);
  const raw = Buffer.concat([Buffer.from(`${object.type} ${object.data.length}\0`), object.data]);
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(deflateSync(raw)); await handle.sync(); await handle.close();
    await fs.link(temporary, destination).catch(async error => {
      if (error.code !== "EEXIST") throw error;
      const existing = await fs.lstat(destination);
      if (!existing.isFile() || existing.isSymbolicLink()) throw new UpdateError("ARCHIVE_OBJECT_STORE_UNSAFE");
      try {
        if (!inflateSync(await fs.readFile(destination), { maxOutputLength: raw.length }).equals(raw)) throw new Error();
      } catch { throw new UpdateError("ARCHIVE_OBJECT_STORE_UNSAFE"); }
    });
  } finally { await handle.close().catch(() => {}); await fs.rm(temporary, { force: true }); }
}

export async function importOfficialArchive(options: {
  root: string; mergeRef: string; hasCommit: (sha: string) => Promise<boolean>;
}): Promise<string> {
  if (!options.mergeRef.startsWith("refs/heads/")) throw new UpdateError("UNSAFE_UPSTREAM");
  const signal = AbortSignal.timeout(180_000);
  const checkDeadline = () => { if (signal.aborted) throw new UpdateError("ARCHIVE_NETWORK_FAILED"); };
  const read = (url: string, max = 1024 * 1024) => { checkDeadline(); return githubArchiveTransport.read(url, max, signal); };
  const branch = options.mergeRef.slice("refs/heads/".length);
  const tip = json(await read(`${API}/commits/${encodeURIComponent(branch)}`));
  const target = validSha(tip.sha);
  const commits = new Map<string, { raw: Buffer; tree: string; parents: string[] }>();
  let transferred = 0, expanded = 0;
  const pending = [target];
  while (pending.length) {
    checkDeadline();
    const sha = pending.pop()!;
    if (commits.has(sha) || await options.hasCommit(sha)) continue;
    if (commits.size >= 64) throw new UpdateError("ARCHIVE_HISTORY_LIMIT");
    const data = json(await read(`${API}/git/commits/${sha}`));
    if (data.sha !== sha || !Array.isArray(data.parents) || data.parents.length > 16) throw new UpdateError("ARCHIVE_METADATA_INVALID");
    const raw = reconstructCommit(data), tree = validSha(data.tree?.sha);
    const parents = data.parents.map((p: any) => validSha(p.sha));
    // Cross-check metadata used for traversal/download against the hashed object.
    const header = raw.toString("utf8").split("\n\n")[0]!;
    if (!header.startsWith(`tree ${tree}\n`) || JSON.stringify(header.split("\n").filter(l => l.startsWith("parent ")).map(l => l.slice(7))) !== JSON.stringify(parents)) throw new UpdateError("ARCHIVE_METADATA_INVALID");
    commits.set(sha, { raw, tree, parents }); pending.push(...parents);
  }
  const downloadedTrees = new Set<string>();
  for (const [sha, commit] of commits) {
    if (!downloadedTrees.has(commit.tree)) {
      const archive = await read(`${DOWNLOAD}${sha}`, 32 * 1024 * 1024);
      transferred += archive.length;
      if (transferred > 128 * 1024 * 1024) throw new UpdateError("ARCHIVE_LIMIT");
      const objects = archiveObjects(archive, commit.tree);
      for (const [id, object] of objects) {
        expanded += object.data.length;
        if (expanded > 512 * 1024 * 1024) throw new UpdateError("ARCHIVE_LIMIT");
        checkDeadline(); await storeObject(options.root, id, object);
      }
      downloadedTrees.add(commit.tree);
    }
  }
  // Only publish commit objects after ALL required snapshots are verified/stored.
  const stored = new Set<string>();
  const publish = async (sha: string, visiting = new Set<string>()): Promise<void> => {
    if (stored.has(sha) || !commits.has(sha)) return;
    if (visiting.has(sha)) throw new UpdateError("ARCHIVE_METADATA_INVALID");
    visiting.add(sha);
    const commit = commits.get(sha)!;
    for (const parent of commit.parents) await publish(parent, visiting);
    checkDeadline();
    await storeObject(options.root, sha, { type: "commit", data: commit.raw });
    stored.add(sha); visiting.delete(sha);
  };
  await publish(target);
  return target;
}
