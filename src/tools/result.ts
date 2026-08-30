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
  const json = JSON.stringify(value, null, 2);
  const bytes = Buffer.byteLength(json, "utf8");

  return {
    content: json,
    bytes,
    truncated: false
  };
}
