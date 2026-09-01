import { jsonResponse } from './_json-response.js';

export const config = { runtime: 'edge' };

export default function handler(req) {
  // cf-ipcountry is real client geography only on requests that actually transited
  // the Cloudflare zone; on a direct-to-origin hit it is a plain client-supplied
  // header, and Vercel rewrites only its own x-vercel-* names. The read is left
  // ungated here (unlike api/_usage-telemetry.js deriveCountry, which gates it on
  // hasCloudflareTransitProof) because the answer only geo-filters the caller's OWN
  // live-channel list, so spoofing it changes nothing but the spoofer's UI. Never
  // consume this endpoint for an authorization, entitlement, or pricing decision
  // without adding that gate first.
  const cfCountry = req.headers.get('cf-ipcountry');
  const country = (cfCountry && cfCountry !== 'T1' ? cfCountry : null) || req.headers.get('x-vercel-ip-country') || 'XX';
  // no-store: the body IS the caller's IP-geo, so the answer depends entirely on
  // the request -- the same rule api/bootstrap.js applies to its origin-dependent
  // responses. A `Vary` on the geo headers is not an option here: the Cloudflare
  // zone in front of api.worldmonitor.app ignores Vary (see TIER_CACHE in
  // api/bootstrap.js), so a shared-cacheable response pins the FIRST visitor's
  // country onto every later caller at that PoP for the whole s-maxage window.
  // The client trusts any non-'XX' value (src/utils/user-location.ts) to
  // geo-filter the live-channel list, so the mismatch is silent. Losing the cache
  // costs nothing: resolveUserCountryCode memoizes into a module-level promise and
  // its only caller is the channel-management panel, never the page-load path, so
  // this is at most one edge invocation per page load.
  return jsonResponse({ country }, 200, {
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
}
