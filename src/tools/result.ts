export const DEFAULT_TOOL_RESULT_MAX_BYTES = 32_000;
const TRUNCATION_MARKER = "\n...[tool result truncated]";

export type ToolResultValue = {
  ok?: boolean;
  result?: unknown;
  error?: unknown;
  blocked?: boolean;
  interrupted?: boolean;
  decision?: Record<string, unknown>;
  [key: string]: unknown;
};

export type SerializedToolResult = {
  content: string;
  bytes: number;
  truncated: boolean;
};

export function serializeToolResult(
  value: ToolResultValue,
  options: { maxBytes?: number } = {}
): SerializedToolResult {
  return capToolResultText(JSON.stringify(value, null, 2), options);
}

export function capToolResultText(
  text: string,
  options: { maxBytes?: number; truncated?: boolean } = {}
): SerializedToolResult {
  const bytes = Buffer.byteLength(text, "utf8");
  const maxBytes = positiveInteger(options.maxBytes);
  if (!maxBytes || bytes <= maxBytes) {
    return {
      content: text,
      bytes,
      truncated: options.truncated === true
    };
  }
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  const keep = Math.max(0, maxBytes - markerBytes);
  const content = `${utf8Prefix(text, keep)}${TRUNCATION_MARKER}`;
  return {
    content,
    bytes: Buffer.byteLength(content, "utf8"),
    truncated: true
  };
}

function positiveInteger(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function utf8Prefix(text: string, maxBytes: number) {
  if (maxBytes <= 0) {
    return "";
  }
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) {
    return text;
  }
  const decoder = new TextDecoder("utf-8");
  const sliced = decoder.decode(buffer.subarray(0, maxBytes), { stream: true });
  if (Buffer.byteLength(sliced, "utf8") <= maxBytes) {
    return sliced;
  }
  let bytes = 0;
  let end = 0;
  for (const point of sliced) {
    const pointBytes = Buffer.byteLength(point, "utf8");
    if (bytes + pointBytes > maxBytes) {
      break;
    }
    bytes += pointBytes;
    end += point.length;
  }
  return sliced.slice(0, end);
}
