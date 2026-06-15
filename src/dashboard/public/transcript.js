export function visibleTranscriptRole(role) {
  if (role === "assistant") return "assistant";
  if (role === "user") return "user";
  return null;
}
