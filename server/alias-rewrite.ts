/**
 * URL-rewrite alias helper for legacy v1 paths that were renamed during the
 * sebuf migration (#3207). The sebuf generator produces RPC URLs derived from
 * method names (e.g. `run-scenario`), which diverge from the documented v1
 * URLs (`run`). These aliases keep the old documented URLs working byte-for-
 * byte — external callers, docs, and partner scripts don't break.
 *
 * Each alias edge function rewrites the request pathname to the new sebuf
 * path and hands off to the domain gateway. The gateway applies auth, rate
 * limiting, and entitlement checks against the *new* path, so premium
 * gating / cache tiers / entitlement maps stay keyed on a single canonical
 * URL.
 *
 * Trivially deleted when v1 retires — just `rm` the alias files.
 */
export async function rewriteToSebuf(
  req: Request,
  newPath: string,
  gateway: (req: Request, ctx: { waitUntil: (p: Promise<unknown>) => void }) => Promise<Response>,
  ctx: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response> {
  const url = new URL(req.url);
  url.pathname = newPath;
  const body =
    req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
  const rewritten = new Request(url.toString(), {
    method: req.method,
    headers: req.headers,
    body,
  });
  return gateway(rewritten, ctx);
}
