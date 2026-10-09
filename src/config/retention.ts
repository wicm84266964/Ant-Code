export const DEFAULT_TRANSCRIPT_RETENTION_DAYS: number | null = null;

/**
 * Missing or unreadable retention means keep sessions. Null is permanent.
 * Zero still means keep nothing. An explicit day count is honored.
 */
export function resolveTranscriptRetentionDays(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return DEFAULT_TRANSCRIPT_RETENTION_DAYS;
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3650) {
    return value;
  }
  return DEFAULT_TRANSCRIPT_RETENTION_DAYS;
}
