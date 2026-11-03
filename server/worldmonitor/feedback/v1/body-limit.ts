/**
 * Decision 4 of the agent feedback threat model: REST reads the body with a
 * bounded reader that aborts at FEEDBACK_MAX_BODY_BYTES (413), whether or not
 * Content-Length is present. The generated route calls `req.json()` with no
 * cap, so the cap runs before the gateway. Its own responses carry the
 * gateway's CORS headers, so a browser caller sees the real status.
 */

import { readBoundedRequestBody, RequestBodyTooLargeError } from '../../../../api/mcp/bounded-body';
import { FEEDBACK_MAX_BODY_BYTES } from '../../../_shared/agent-feedback';
import { getCorsHeaders } from '../../../cors';

function jsonError(req: Request, status: number, message: string): Response {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export function withFeedbackBodyLimit<H extends (req: Request, ...rest: never[]) => Promise<Response>>(
  gateway: H,
  maxBytes = FEEDBACK_MAX_BODY_BYTES,
): H {
  const wrapped = async (req: Request, ...rest: never[]): Promise<Response> => {
    if (req.method !== 'POST') return gateway(req, ...rest);
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedRequestBody(req, maxBytes);
    } catch (err) {
      if (err instanceof RequestBodyTooLargeError) {
        return jsonError(req, 413, `Request body exceeds ${maxBytes} bytes.`);
      }
      // A body that fails mid-read (client abort, broken stream) is the
      // caller's fault, not a server error.
      return jsonError(req, 400, 'Request body could not be read.');
    }
    return gateway(new Request(req, { body: bytes as Uint8Array<ArrayBuffer> }), ...rest);
  };
  return wrapped as H;
}
