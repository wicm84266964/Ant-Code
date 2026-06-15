/**
 * @param {{ ok: boolean; result?: unknown; error?: unknown; blocked?: boolean; decision?: unknown }} value
 * @param {{ maxBytes?: number }} options
 */
export function serializeToolResult(value, options = {}) {
  const json = JSON.stringify(value, null, 2);
  const bytes = Buffer.byteLength(json, "utf8");

  return {
    content: json,
    bytes,
    truncated: false
  };
}
