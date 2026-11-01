// Citable request id on MCP errors (#8721 phase 5).
//
// Every JSON-RPC error the MCP handler returns carries `error.data.requestId`,
// set from the same `deriveRequestId()` (the platform `x-vercel-id`) that the
// wm_api_usage row records as `request_id`. An agent can quote it in a support
// request or a `report_issue` call, and the report joins to its usage row.
//
// This runs once on the handler's single exit instead of at the ~100 error
// sites, so a new error path cannot forget it. It only touches JSON bodies:
// streamed SSE responses and bodiless responses pass through untouched, and a
// response with no error envelope is returned as the same object.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Adds requestId to one JSON-RPC message in place. Returns true when it changed.
function stampMessage(message: unknown, requestId: string): boolean {
  if (!isPlainObject(message) || !isPlainObject(message.error)) return false;
  const error = message.error;
  if (error.data === undefined) {
    error.data = { requestId };
    return true;
  }
  // A non-object data value (string, array) is the error's own detail, and an
  // existing requestId came from a deeper layer: leave both as they are.
  if (!isPlainObject(error.data) || 'requestId' in error.data) return false;
  error.data.requestId = requestId;
  return true;
}

export async function attachRequestIdToErrors(res: Response, requestId: string): Promise<Response> {
  if (!requestId || res.body === null) return res;
  const contentType = res.headers.get('Content-Type') ?? '';
  if (!/application\/json/i.test(contentType)) return res;

  const text = await res.clone().text();
  // Tool results can be large; skip the parse when no envelope can be present.
  if (!text.includes('"error"')) return res;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return res;
  }

  let changed = false;
  if (Array.isArray(parsed)) {
    for (const message of parsed) changed = stampMessage(message, requestId) || changed;
  } else {
    changed = stampMessage(parsed, requestId);
  }
  if (!changed) return res;

  const body = JSON.stringify(parsed);
  const headers = new Headers(res.headers);
  if (headers.has('Content-Length')) headers.set('Content-Length', String(new TextEncoder().encode(body).byteLength));
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}
