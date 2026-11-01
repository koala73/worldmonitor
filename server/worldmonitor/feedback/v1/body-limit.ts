/**
 * Decision 4 of the agent feedback threat model: REST reads the body with a
 * bounded reader that aborts at FEEDBACK_MAX_BODY_BYTES (413), whether or not
 * Content-Length is present. The generated route calls `req.json()` with no
 * cap, so the cap runs before the gateway.
 */

import { readBoundedRequestBody, RequestBodyTooLargeError } from '../../../../api/mcp/bounded-body';
import { FEEDBACK_MAX_BODY_BYTES } from '../../../_shared/agent-feedback';

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
        return new Response(JSON.stringify({ message: `Request body exceeds ${maxBytes} bytes.` }), {
          status: 413,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      }
      throw err;
    }
    return gateway(new Request(req, { body: bytes as Uint8Array<ArrayBuffer> }), ...rest);
  };
  return wrapped as H;
}
