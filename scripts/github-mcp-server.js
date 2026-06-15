#!/usr/bin/env node
import readline from "node:readline";

const API_ROOT = "https://api.github.com";
const RAW_ROOT = "https://raw.githubusercontent.com";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 64_000;

const tools = Object.freeze([
  {
    name: "get_file_contents",
    description: "Read a file from a GitHub repository through raw.githubusercontent.com.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        path: { type: "string" },
        ref: { type: "string" },
        maxBytes: { type: "number" }
      },
      required: ["owner", "repo", "path"]
    }
  },
  {
    name: "search_repositories",
    description: "Search GitHub repositories with the GitHub REST API.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        perPage: { type: "number" }
      },
      required: ["query"]
    }
  },
  {
    name: "list_branches",
    description: "List repository branches.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        perPage: { type: "number" }
      },
      required: ["owner", "repo"]
    }
  },
  {
    name: "list_releases",
    description: "List repository releases.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        perPage: { type: "number" }
      },
      required: ["owner", "repo"]
    }
  },
  {
    name: "get_latest_release",
    description: "Read the latest repository release.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" }
      },
      required: ["owner", "repo"]
    }
  },
  {
    name: "list_issues",
    description: "List repository issues.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        state: { type: "string" },
        perPage: { type: "number" }
      },
      required: ["owner", "repo"]
    }
  },
  {
    name: "get_issue",
    description: "Read one repository issue.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        issueNumber: { type: "number" }
      },
      required: ["owner", "repo", "issueNumber"]
    }
  },
  {
    name: "list_pull_requests",
    description: "List repository pull requests.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        state: { type: "string" },
        perPage: { type: "number" }
      },
      required: ["owner", "repo"]
    }
  },
  {
    name: "get_pull_request",
    description: "Read one repository pull request.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        pullNumber: { type: "number" }
      },
      required: ["owner", "repo", "pullNumber"]
    }
  },
  {
    name: "get_pull_request_files",
    description: "List files changed by one pull request.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        pullNumber: { type: "number" },
        perPage: { type: "number" }
      },
      required: ["owner", "repo", "pullNumber"]
    }
  }
]);

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  if (!line.trim()) {
    return;
  }

  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (!("id" in request)) {
    return;
  }

  try {
    if (request.method === "initialize") {
      respond(request.id, {
        protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "ant-code-github-readonly", version: "0.1.0" }
      });
    } else if (request.method === "tools/list") {
      respond(request.id, { tools });
    } else if (request.method === "tools/call") {
      const result = await callTool(request.params?.name, request.params?.arguments ?? {});
      respond(request.id, result);
    } else if (request.method === "prompts/list") {
      respond(request.id, { prompts: [] });
    } else if (request.method === "resources/list") {
      respond(request.id, { resources: [] });
    } else if (request.method === "resources/read") {
      respond(request.id, { contents: [] });
    } else {
      respond(request.id, null, { code: -32601, message: `Unknown method: ${request.method}` });
    }
  } catch (error) {
    respond(request.id, null, {
      code: -32000,
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

async function callTool(name, args) {
  if (name === "get_file_contents") {
    return textResult(await getFileContents(args));
  }
  if (name === "search_repositories") {
    return jsonResult(await githubJson(`/search/repositories?q=${encodeURIComponent(requiredString(args.query, "query"))}&per_page=${perPage(args.perPage)}`));
  }
  if (name === "list_branches") {
    return jsonResult(await githubJson(`/repos/${ownerRepo(args)}/branches?per_page=${perPage(args.perPage)}`));
  }
  if (name === "list_releases") {
    return jsonResult(await githubJson(`/repos/${ownerRepo(args)}/releases?per_page=${perPage(args.perPage)}`));
  }
  if (name === "get_latest_release") {
    return jsonResult(await githubJson(`/repos/${ownerRepo(args)}/releases/latest`));
  }
  if (name === "list_issues") {
    const state = enumValue(args.state, ["open", "closed", "all"], "open");
    return jsonResult(await githubJson(`/repos/${ownerRepo(args)}/issues?state=${state}&per_page=${perPage(args.perPage)}`));
  }
  if (name === "get_issue") {
    return jsonResult(await githubJson(`/repos/${ownerRepo(args)}/issues/${positiveInteger(args.issueNumber, "issueNumber")}`));
  }
  if (name === "list_pull_requests") {
    const state = enumValue(args.state, ["open", "closed", "all"], "open");
    return jsonResult(await githubJson(`/repos/${ownerRepo(args)}/pulls?state=${state}&per_page=${perPage(args.perPage)}`));
  }
  if (name === "get_pull_request") {
    return jsonResult(await githubJson(`/repos/${ownerRepo(args)}/pulls/${positiveInteger(args.pullNumber, "pullNumber")}`));
  }
  if (name === "get_pull_request_files") {
    return jsonResult(await githubJson(`/repos/${ownerRepo(args)}/pulls/${positiveInteger(args.pullNumber, "pullNumber")}/files?per_page=${perPage(args.perPage)}`));
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function getFileContents(args) {
  const owner = requiredSlug(args.owner, "owner");
  const repo = requiredSlug(args.repo, "repo");
  const filePath = String(args.path ?? "").replace(/^\/+/, "");
  if (!filePath || filePath.includes("..")) {
    throw new Error("path is required and must not contain '..'");
  }
  const ref = String(args.ref ?? "main").trim() || "main";
  const url = `${RAW_ROOT}/${owner}/${repo}/${encodeURIComponent(ref).replace(/%2F/g, "/")}/${filePath.split("/").map(encodeURIComponent).join("/")}`;
  const response = await fetchWithTimeout(url);
  const text = await boundedText(response, boundedPositive(args.maxBytes, DEFAULT_MAX_BYTES));
  if (!response.ok) {
    throw new Error(`GitHub raw request failed ${response.status}: ${text.slice(0, 300)}`);
  }
  return {
    url,
    owner,
    repo,
    path: filePath,
    ref,
    bytes: Buffer.byteLength(text, "utf8"),
    content: text
  };
}

async function githubJson(path) {
  const response = await fetchWithTimeout(`${API_ROOT}${path}`);
  const text = await boundedText(response, DEFAULT_MAX_BYTES);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!response.ok) {
    const message = typeof json.message === "string" ? json.message : text.slice(0, 300);
    throw new Error(`GitHub API request failed ${response.status}: ${message}`);
  }
  return json;
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const headers = {
      accept: "application/vnd.github+json",
      "user-agent": "ant-code-github-mcp/0.1",
      "x-github-api-version": "2022-11-28"
    };
    const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }
    return await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function boundedText(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = Buffer.from(value);
    const remaining = maxBytes - bytes;
    if (remaining <= 0) {
      break;
    }
    chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
    bytes += Math.min(chunk.length, remaining);
    if (chunk.length > remaining) {
      break;
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

function ownerRepo(args) {
  return `${requiredSlug(args.owner, "owner")}/${requiredSlug(args.repo, "repo")}`;
}

function requiredString(value, name) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error(`${name} is required`);
  }
  return text;
}

function requiredSlug(value, name) {
  const text = requiredString(value, name);
  if (!/^[A-Za-z0-9_.-]+$/.test(text)) {
    throw new Error(`${name} must be a GitHub owner/repo slug`);
  }
  return text;
}

function perPage(value) {
  return boundedPositive(value, 10, 1, 50);
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return number;
}

function enumValue(value, allowed, fallback) {
  const text = String(value ?? fallback);
  return allowed.includes(text) ? text : fallback;
}

function boundedPositive(value, fallback, min = 1024, max = 256_000) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min) {
    return fallback;
  }
  return Math.min(number, max);
}

function textResult(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function jsonResult(value) {
  return textResult(value);
}

function respond(id, result, error = null) {
  const message = error
    ? { jsonrpc: "2.0", id, error }
    : { jsonrpc: "2.0", id, result };
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
