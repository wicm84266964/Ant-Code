#!/usr/bin/env node
import http from "node:http";
import { fileURLToPath } from "node:url";

if (isMainModule()) {
  const options = parseArgs(process.argv.slice(2));
  const host = options.host ?? "127.0.0.1";
  const port = Number(options.port ?? process.env.LAB_AGENT_MOCK_GATEWAY_PORT ?? 8787);
  const stream = Boolean(options.stream ?? process.env.LAB_AGENT_MOCK_GATEWAY_STREAM);

  const server = createMockGatewayServer({ stream });

  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`Mock lab gateway listening at http://${host}:${actualPort}/v1/chat`);
    console.log(`Mock lab gateway health at http://${host}:${actualPort}/health`);
  });

  process.on("SIGINT", () => {
    server.close(() => process.exit(0));
  });
}

/**
 * @param {{ stream?: boolean }} options
 */
export function createMockGatewayServer(options = {}) {
  return http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        service: "mock-lab-gateway",
        protocolVersion: "lab-agent-gateway.v1"
      }));
      return;
    }

    if (request.method !== "POST" || request.url !== "/v1/chat") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "unknown route" } }));
      return;
    }

    const body = await readRequestJson(request);
    const assistant = createMockGatewayResponse(body);
    const openAIChat = isOpenAIChatRequest(body);
    const text = assistant.content.map((block) => block.text).join("");

    if (options.stream && assistant.toolCalls.length === 0) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (openAIChat) {
        for (const chunk of splitText(text)) {
          response.write(`data: ${JSON.stringify({
            id: assistant.id,
            object: "chat.completion.chunk",
            model: assistant.model,
            choices: [{ delta: { content: chunk } }]
          })}\n\n`);
        }
        response.write(`data: ${JSON.stringify({
          id: assistant.id,
          object: "chat.completion.chunk",
          model: assistant.model,
          choices: [{ delta: {}, finish_reason: assistant.stopReason ?? "stop" }],
          usage: assistant.usage
        })}\n\n`);
      } else {
        response.write(`data: ${JSON.stringify({ type: "message_start", id: assistant.id, model: assistant.model })}\n\n`);
        for (const chunk of splitText(text)) {
          response.write(`data: ${JSON.stringify({ type: "text_delta", text: chunk })}\n\n`);
        }
        response.write(`data: ${JSON.stringify({ type: "message_stop", stopReason: "stop" })}\n\n`);
      }
      response.write("data: [DONE]\n\n");
      response.end();
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(openAIChat ? toOpenAIChatResponse(assistant) : assistant));
  });
}

/**
 * @param {Record<string, any>} body
 */
function isOpenAIChatRequest(body) {
  return !body.protocolVersion && Array.isArray(body.messages) && (
    Array.isArray(body.tools) ||
    body.stream !== undefined ||
    body.messages.some((message) => message.role === "tool" || Array.isArray(message.tool_calls))
  );
}

/**
 * @param {Record<string, any>} assistant
 */
function toOpenAIChatResponse(assistant) {
  return {
    id: assistant.id,
    object: "chat.completion",
    model: assistant.model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: assistant.content.map((block) => block.text).join(""),
        tool_calls: assistant.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.input ?? {})
          }
        }))
      },
      finish_reason: assistant.toolCalls.length > 0 ? "tool_calls" : assistant.stopReason ?? "stop"
    }],
    usage: assistant.usage
  };
}

/**
 * @param {http.IncomingMessage} request
 */
async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

/**
 * @param {Record<string, any>} body
 */
function createMockGatewayResponse(body) {
  const toolResults = Array.isArray(body.toolResults) ? body.toolResults : [];
  if (toolResults.length > 0) {
    const text = summarizeToolResults(toolResults);
    return createTextResponse(body, text);
  }

  const lastUser = [...(body.messages ?? [])].reverse().find((message) => message.role === "user");
  const prompt = normalizeContent(lastUser?.content);
  const toolCall = createRequestedToolCall(prompt);
  if (toolCall) {
    return {
      id: "mock-tool-request-1",
      model: body.model,
      content: [],
      toolCalls: [toolCall],
      stopReason: "tool_use",
      usage: {
        promptBytes: JSON.stringify(body.messages ?? []).length,
        completionBytes: 0
      }
    };
  }

  const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;
  return createTextResponse(body, `Mock gateway response for model ${body.model ?? "unknown"}: ${prompt} (${toolCount} tools available)`);
}

/**
 * @param {Record<string, any>} body
 * @param {string} text
 */
function createTextResponse(body, text) {
  return {
    id: "mock-msg-1",
    model: body.model,
    content: [{ type: "text", text }],
    toolCalls: [],
    stopReason: "stop",
    usage: {
      promptBytes: JSON.stringify(body.messages ?? []).length,
      completionBytes: Buffer.byteLength(text, "utf8")
    }
  };
}

/**
 * @param {string} prompt
 */
function createRequestedToolCall(prompt) {
  const readMatch = prompt.match(/\bread_file\s+([^\s]+)/i) ?? prompt.match(/\bread\s+file\s+([^\s]+)/i);
  if (readMatch) {
    return {
      id: "mock-tool-1",
      name: "read_file",
      input: { path: cleanPathToken(readMatch[1]), maxBytes: 4096 }
    };
  }

  const listMatch = prompt.match(/\blist_files(?:\s+([^\s]+))?/i) ?? prompt.match(/\blist\s+files(?:\s+([^\s]+))?/i);
  if (listMatch) {
    return {
      id: "mock-tool-1",
      name: "list_files",
      input: { path: cleanPathToken(listMatch[1] ?? ".") }
    };
  }

  const grepMatch = prompt.match(/\bgrep\s+(.+?)\s+in\s+([^\s]+)/i);
  if (grepMatch) {
    return {
      id: "mock-tool-1",
      name: "grep",
      input: {
        pattern: stripQuotes(grepMatch[1].trim()),
        path: cleanPathToken(grepMatch[2]),
        maxMatches: 10
      }
    };
  }

  const globMatch = prompt.match(/\bglob\s+([^\s]+)/i);
  if (globMatch) {
    return {
      id: "mock-tool-1",
      name: "glob",
      input: { pattern: stripQuotes(globMatch[1]), maxMatches: 20 }
    };
  }

  if (/\bgit_status\b/i.test(prompt) || /\bgit\s+status\b/i.test(prompt)) {
    return {
      id: "mock-tool-1",
      name: "git_status",
      input: {}
    };
  }

  if (/\bgit_diff\b/i.test(prompt) || /\bgit\s+diff\b/i.test(prompt)) {
    return {
      id: "mock-tool-1",
      name: "git_diff",
      input: { stat: /\bstat\b/i.test(prompt) }
    };
  }

  const writeMatch = prompt.match(/\bwrite_file\s+([^\s]+)\s+([\s\S]+)/i);
  if (writeMatch) {
    return {
      id: "mock-tool-1",
      name: "write_file",
      input: {
        path: cleanPathToken(writeMatch[1]),
        content: stripOuterQuotes(writeMatch[2].trim())
      }
    };
  }

  const editMatch = prompt.match(/\bedit_file\s+([^\s]+)\s+([\s\S]+?)\s*=>\s*([\s\S]+)/i);
  if (editMatch) {
    return {
      id: "mock-tool-1",
      name: "edit_file",
      input: {
        path: cleanPathToken(editMatch[1]),
        oldText: stripOuterQuotes(editMatch[2].trim()),
        newText: stripOuterQuotes(editMatch[3].trim()),
        expectedReplacements: 1
      }
    };
  }

  const powershellMatch = prompt.match(/\bpowershell\s+([\s\S]+)/i);
  if (powershellMatch) {
    return {
      id: "mock-tool-1",
      name: "powershell",
      input: {
        command: stripOuterQuotes(powershellMatch[1].trim()),
        timeoutMs: 10_000
      }
    };
  }

  const bashMatch = prompt.match(/\bbash\s+([\s\S]+)/i);
  if (bashMatch) {
    return {
      id: "mock-tool-1",
      name: "bash",
      input: {
        command: stripOuterQuotes(bashMatch[1].trim()),
        timeoutMs: 10_000
      }
    };
  }

  const todoWriteMatch = prompt.match(/\btodo_write\s+([\s\S]+)/i);
  if (todoWriteMatch) {
    return {
      id: "mock-tool-1",
      name: "todo_write",
      input: {
        items: splitList(todoWriteMatch[1]).map((content) => ({ content, status: "pending" }))
      }
    };
  }

  if (/\btodo_read\b/i.test(prompt)) {
    return {
      id: "mock-tool-1",
      name: "todo_read",
      input: {}
    };
  }

  const planMatch = prompt.match(/\bplan_update\s+([\s\S]+)/i);
  if (planMatch) {
    return {
      id: "mock-tool-1",
      name: "plan_update",
      input: {
        steps: splitList(planMatch[1]).map((content) => ({ content, status: "pending" }))
      }
    };
  }

  const askUserMatch = prompt.match(/\bask_user\s+([\s\S]+)/i);
  if (askUserMatch) {
    return {
      id: "mock-tool-1",
      name: "ask_user",
      input: {
        question: stripOuterQuotes(askUserMatch[1].trim())
      }
    };
  }

  const mcpMatch = prompt.match(/\bmcp_call\s+([^\s]+)\s+([^\s]+)(?:\s+([\s\S]+))?/i);
  if (mcpMatch) {
    return {
      id: "mock-tool-1",
      name: "mcp_call",
      input: {
        server: cleanPathToken(mcpMatch[1]),
        tool: cleanPathToken(mcpMatch[2]),
        arguments: mcpMatch[3] ? JSON.parse(stripOuterQuotes(mcpMatch[3].trim())) : {}
      }
    };
  }

  return null;
}

/**
 * @param {Array<Record<string, any>>} toolResults
 */
function summarizeToolResults(toolResults) {
  const summaries = [];
  for (const result of toolResults) {
    const parsed = parseToolResult(result.content);
    if (!parsed.ok) {
      summaries.push(`Tool ${result.name} did not complete: ${JSON.stringify(parsed.error ?? parsed.decision ?? parsed)}`);
    } else if (result.name === "read_file") {
      summaries.push(`Tool read_file returned ${parsed.result.path}:\n${parsed.result.content.slice(0, 800)}`);
    } else if (result.name === "list_files") {
      const names = parsed.result.map((entry) => `${entry.type}:${entry.name}`).join(", ");
      summaries.push(`Tool list_files returned: ${names}`);
    } else if (result.name === "grep") {
      const matches = parsed.result.matches.map((match) => `${match.path}:${match.line}:${match.text}`).join("\n");
      summaries.push(`Tool grep returned:\n${matches || "no matches"}`);
    } else if (result.name === "glob") {
      summaries.push(`Tool glob returned: ${parsed.result.matches.join(", ") || "no matches"}`);
    } else if (result.name === "git_status" || result.name === "git_diff") {
      const output = [parsed.result.stdout, parsed.result.stderr].filter(Boolean).join("\n");
      summaries.push(`Tool ${result.name} exited ${parsed.result.exitCode}:\n${output || "no output"}`);
    } else if (result.name === "write_file") {
      summaries.push(`Tool write_file wrote ${parsed.result.path}:\n${parsed.result.diff}`);
    } else if (result.name === "edit_file") {
      if (parsed.result.edited === false) {
        summaries.push(`Tool edit_file did not edit ${parsed.result.path}: ${parsed.result.error?.message ?? "unknown edit error"}`);
      } else {
        summaries.push(`Tool edit_file edited ${parsed.result.path}:\n${parsed.result.diff}`);
      }
    } else if (result.name === "powershell" || result.name === "bash") {
      const output = [parsed.result.stdout, parsed.result.stderr].filter(Boolean).join("\n");
      summaries.push(`Tool ${result.name} exited ${parsed.result.exitCode}${parsed.result.timedOut ? " after timeout" : ""}:\n${output}`);
    } else if (result.name === "todo_read") {
      summaries.push(`Tool todo_read returned: ${JSON.stringify(parsed.result)}`);
    } else if (result.name === "todo_write") {
      summaries.push(`Tool todo_write updated ${parsed.result.todos.length} todos`);
    } else if (result.name === "plan_update") {
      summaries.push(`Tool plan_update updated ${parsed.result.steps.length} steps`);
    } else if (result.name === "ask_user") {
      summaries.push(`Tool ask_user returned: ${JSON.stringify(parsed.result)}`);
    } else if (result.name === "mcp_call") {
      summaries.push(`Tool mcp_call returned: ${JSON.stringify(parsed.result)}`);
    } else {
      summaries.push(`Tool ${result.name} returned: ${JSON.stringify(parsed.result)}`);
    }
  }
  return summaries.join("\n\n");
}

/**
 * @param {unknown} content
 */
function parseToolResult(content) {
  const text = normalizeContent(content);
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: { code: "MOCK_PARSE_ERROR", message: "tool result was not JSON" } };
  }
}

/**
 * @param {unknown} content
 */
function normalizeContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => typeof block === "string" ? block : block?.text ?? "")
    .join("");
}

/**
 * @param {string} value
 */
function cleanPathToken(value) {
  return stripQuotes(value).replace(/[.,;:]$/, "");
}

/**
 * @param {string} value
 */
function stripQuotes(value) {
  return value.replace(/^["']|["']$/g, "");
}

/**
 * @param {string} value
 */
function stripOuterQuotes(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * @param {string} value
 */
function splitList(value) {
  return value.split("|")
    .map((item) => stripOuterQuotes(item.trim()))
    .filter(Boolean);
}

/**
 * @param {string} text
 */
function splitText(text) {
  const middle = Math.max(1, Math.floor(text.length / 2));
  return [text.slice(0, middle), text.slice(middle)].filter(Boolean);
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--host") {
      parsed.host = argv[index + 1];
      index += 1;
    } else if (item === "--port") {
      parsed.port = argv[index + 1];
      index += 1;
    } else if (item === "--stream") {
      parsed.stream = true;
    }
  }
  return parsed;
}

function isMainModule() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}
