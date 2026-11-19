/**
 * Convex reports rejected cursors through its message or structured error data.
 * Cursors are opaque, and a generic JSON parse failure does not identify a
 * cursor error. Keep convex-test's JSON cursor encoding out of this contract.
 */

const CURSOR_ERROR_TEXT = /Failed to parse cursor|InvalidCursor/;

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "";
}

function errorData(err: unknown): unknown {
  const raw = (err as { data?: unknown } | null)?.data;
  if (typeof raw !== "string") return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function dataNamesInvalidCursor(data: unknown): boolean {
  if (typeof data === "string") return data === "InvalidCursor" || CURSOR_ERROR_TEXT.test(data);
  if (!data || typeof data !== "object") return false;
  const record = data as Record<string, unknown>;
  if (record.paginationError === "InvalidCursor") return true;
  if (record.code === "InvalidCursor" || record.kind === "InvalidCursor") return true;
  return typeof record.message === "string" && CURSOR_ERROR_TEXT.test(record.message);
}

export function isInvalidPaginationCursorError(err: unknown): boolean {
  const message = errorMessage(err);
  if (CURSOR_ERROR_TEXT.test(message)) return true;
  return dataNamesInvalidCursor(errorData(err));
}

export function isInvalidCursorPage(result: unknown): boolean {
  return !!result
    && typeof result === "object"
    && (result as { error?: unknown }).error === "INVALID_CURSOR";
}
