const READONLY_PATTERNS = Object.freeze([
  /^git\s+(status|diff|log|show|branch|rev-parse)\b/i,
  /^(rg|grep|findstr)\b/i,
  /^(ls|dir|pwd|whoami)\b/i,
  /^Get-(ChildItem|Content|Location|Command|Process)\b/i,
  /^npm\s+(test|run\s+test)\b/i
]);

const HIGH_RISK_PATTERNS = Object.freeze([
  /\brm\s+(-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)\b/i,
  /\bRemove-Item\b(?=[\s\S]*-(?:Recurse|r)\b)(?=[\s\S]*-(?:Force|f)\b)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[^\s]*f/i,
  /\bnpm\s+publish\b/i,
  /\b(?:curl|wget)\b[\s\S]*\|\s*(?:sh|bash|pwsh|powershell)\b/i,
  /\bInvoke-Expression\b/i
]);

const NETWORK_PATTERNS = Object.freeze([
  /\b(curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod)\b/i,
  /\b(npm|pnpm|yarn)\s+(install|add|update)\b/i,
  /\b(git)\s+(clone|fetch|pull|push)\b/i
]);

/**
 * @param {string} command
 */
export function classifyCommand(command) {
  const trimmed = command.trim();
  if (!trimmed) {
    return { kind: "empty", risk: "read", reason: "empty command" };
  }

  if (HIGH_RISK_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return { kind: "high-risk", risk: "execute", reason: "matches high-risk command pattern" };
  }

  if (NETWORK_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return { kind: "network", risk: "network", reason: "command may access network" };
  }

  if (READONLY_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return { kind: "readonly", risk: "read", reason: "matches readonly command allowlist" };
  }

  return { kind: "mutating", risk: "execute", reason: "command is not classified as readonly" };
}
