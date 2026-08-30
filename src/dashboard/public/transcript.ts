export function visibleTranscriptRole(role: string) {
  if (role === "assistant") return "assistant";
  if (role === "user") return "user";
  return null;
}
