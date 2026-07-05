/**
 * Turn an unknown thrown value (tRPC error, Error, string) into copy that's
 * safe to show a user. We authored the meaningful messages server-side as
 * plain sentences ("You cannot edit this document."), so those pass through;
 * bare error codes (UNAUTHORIZED), stack traces, and SQL/technical strings are
 * replaced with a generic fallback — never leak internals into the UI.
 */
export function friendlyError(err: unknown, fallback = "Something went wrong. Please try again."): string {
  const msg =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (!msg) return fallback;
  // Bare tRPC/HTTP codes like "UNAUTHORIZED" or "NOT_FOUND".
  if (/^[A-Z][A-Z0-9_]+$/.test(msg.trim())) return fallback;
  // Stack traces / thrown Error strings / multi-line technical output.
  if (/\n|\bat\s.+\(|Error:|https?:\/\/|[{}]|::/.test(msg)) return fallback;
  // A reasonable, human-length sentence — show it.
  return msg.length <= 160 ? msg : fallback;
}
