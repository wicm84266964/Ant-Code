/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const args = {
    command: null,
    print: false,
    prompt: null,
    readonly: false,
    allowWrite: false,
    allowCommand: false,
    fullAccess: false,
    resume: null,
    dashboard: {
      host: "127.0.0.1",
      port: 7410,
      open: true,
      project: null
    },
    outputFormat: "text",
    includePartialMessages: false,
    live: false,
    help: false,
    version: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help" || item === "-h") {
      args.help = true;
    } else if (item === "--version" || item === "-v") {
      args.version = true;
    } else if (item === "--readonly") {
      args.readonly = true;
    } else if (item === "--full-access" || item === "--fullaccess") {
      args.fullAccess = true;
      args.readonly = false;
      args.allowWrite = true;
      args.allowCommand = true;
    } else if (item === "--auto-approve" || item === "--auto-approve-workspace") {
      args.allowWrite = true;
      args.allowCommand = true;
    } else if (item === "--allow-write" || item === "--allow-writes") {
      args.allowWrite = true;
    } else if (item === "--allow-command" || item === "--allow-commands") {
      args.allowCommand = true;
    } else if (item === "--resume") {
      args.resume = argv[index + 1] ?? "latest";
      index += 1;
    } else if (item === "--port") {
      args.dashboard.port = normalizePort(argv[index + 1], args.dashboard.port);
      index += 1;
    } else if (item.startsWith("--port=")) {
      args.dashboard.port = normalizePort(item.slice("--port=".length), args.dashboard.port);
    } else if (item === "--host") {
      args.dashboard.host = argv[index + 1] ?? args.dashboard.host;
      index += 1;
    } else if (item.startsWith("--host=")) {
      args.dashboard.host = item.slice("--host=".length) || args.dashboard.host;
    } else if (item === "--no-open") {
      args.dashboard.open = false;
    } else if (item === "--project") {
      args.dashboard.project = argv[index + 1] ?? null;
      index += 1;
    } else if (item.startsWith("--project=")) {
      args.dashboard.project = item.slice("--project=".length) || null;
    } else if (item === "--output-format") {
      args.outputFormat = normalizeOutputFormat(argv[index + 1] ?? "text");
      index += 1;
    } else if (item.startsWith("--output-format=")) {
      args.outputFormat = normalizeOutputFormat(item.slice("--output-format=".length));
    } else if (item === "--include-partial-messages") {
      args.includePartialMessages = true;
    } else if (item === "--live") {
      args.live = true;
    } else if (item === "-p" || item === "--print") {
      args.print = true;
      args.prompt = argv[index + 1] ?? "";
      index += 1;
    } else if (!args.command && !item.startsWith("-")) {
      args.command = item;
    }
  }

  return args;
}

/**
 * @param {string} value
 */
function normalizeOutputFormat(value) {
  if (value === "json" || value === "stream-json") {
    return value;
  }
  return "text";
}

/**
 * @param {string | undefined} value
 * @param {number} fallback
 */
function normalizePort(value, fallback) {
  const port = Number(value);
  if (Number.isInteger(port) && port > 0 && port <= 65535) {
    return port;
  }
  return fallback;
}
