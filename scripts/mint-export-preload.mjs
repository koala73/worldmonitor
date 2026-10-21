// Preloaded into `mint export` by the doc-anchors job (lint-code.yml) through
// NODE_OPTIONS=--import. It changes nothing about how pages render; it removes
// one crash and names the pages that fail.
//
// 1. `mint export` (@mintlify/previewing local-preview/export.js) awaits
//    `is-online` before anything else, only to decide whether a first run can
//    download the renderer. When that probe passes its 5-second timeout it
//    cancels its HTTP queries, and one cancel path throws "The `onCancel`
//    handler was attached after the promise settled." from p-cancelable as an
//    uncaught exception, killing the export before a page renders. That was 21
//    of the 28 doc-anchors failures between 2026-10-18 and 2026-10-21, on PRs
//    and main alike. The stub answers "online": on a runner that really is
//    offline, the renderer download that follows fails with its own error.
//
// 2. The export fetches every route from a local Next server and, on a failed
//    page, only reports "N page(s) could not be generated": the per-route lines
//    go to an ink log that is cleared before exit. Logging non-OK local fetches
//    to stderr names the route next to the server's own stack trace. That is
//    how an intermittent YAMLException (the other 7 failures) was traced to a
//    generated API-reference page
//    (/api-reference/supplychainservice/getchinacorridorcontroltowers on
//    renderer 0.0.3913); the job now skips those pages with --disable-openapi.

import { register } from 'node:module';

const STUB = 'data:text/javascript,export default async function isOnline() { return true; }';

register(`data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === 'is-online') return { url: ${JSON.stringify(STUB)}, shortCircuit: true };
  return next(specifier, context);
}`)}`);

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const response = await originalFetch(input, init);
  const url = String(input instanceof Request ? input.url : input);
  if (!response.ok && /^http:\/\/localhost:\d+\//.test(url)) {
    process.stderr.write(`mint-export: ${new URL(url).pathname} returned HTTP ${response.status}\n`);
  }
  return response;
};
