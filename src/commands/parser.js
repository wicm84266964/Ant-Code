/**
 * @param {string} input
 */
export function parseSlashCommand(input) {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const parts = splitCommandLine(trimmed.slice(1));
  if (parts.length === 0) {
    return null;
  }

  return {
    name: parts[0],
    args: parts.slice(1),
    raw: trimmed
  };
}

/**
 * @param {string} value
 */
function splitCommandLine(value) {
  const parts = [];
  let current = "";
  let quote = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === "\"" || char === "'") && quote === null) {
      quote = char;
    } else if (char === quote) {
      quote = null;
    } else if (/\s/.test(char) && quote === null) {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}
