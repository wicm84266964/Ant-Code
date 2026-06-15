export const DEFAULT_THINKING_PREVIEW_BYTES = 256 * 1024;

/**
 * Keep the newest thinking/reasoning text within a byte budget.
 *
 * @param {string} value
 * @param {number} maxBytes
 */
export function limitThinkingPreview(value, maxBytes = DEFAULT_THINKING_PREVIEW_BYTES) {
  const text = String(value ?? "");
  const limit = positiveInteger(maxBytes) ?? DEFAULT_THINKING_PREVIEW_BYTES;
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= limit) {
    return {
      text,
      bytes: buffer.length,
      truncated: false,
      omittedBytes: 0
    };
  }

  let start = buffer.length - limit;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
    start += 1;
  }
  const tail = buffer.subarray(start).toString("utf8");
  return {
    text: tail,
    bytes: buffer.length,
    truncated: true,
    omittedBytes: start
  };
}

/**
 * @param {string} current
 * @param {string} addition
 * @param {number} maxBytes
 */
export function appendThinkingPreview(current, addition, maxBytes = DEFAULT_THINKING_PREVIEW_BYTES) {
  return limitThinkingPreview(`${current ?? ""}${addition ?? ""}`, maxBytes);
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}
