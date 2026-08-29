/**
 * RFC 9745 deprecation-policy discovery.
 *
 * A Link with rel="deprecation" MAY appear without a Deprecation header so
 * agents can find the sunset contract before any surface is retired. Absolute
 * URL: API responses are also served from api.worldmonitor.app, where a
 * root-relative /api-versioning.md would 404.
 */

export const DEPRECATION_POLICY_URL = 'https://www.worldmonitor.app/api-versioning.md';

export const DEPRECATION_POLICY_LINK =
  `<${DEPRECATION_POLICY_URL}>; rel="deprecation"; type="text/markdown"`;

const DEPRECATION_REL = /(?:^|,)\s*<[^>]+>\s*;[^,]*\brel="deprecation"/;

export function appendDeprecationPolicyLinkToRecord(headers: Record<string, string>): void {
  const existing = headers.Link;
  if (existing && DEPRECATION_REL.test(existing)) return;
  headers.Link = existing ? `${existing}, ${DEPRECATION_POLICY_LINK}` : DEPRECATION_POLICY_LINK;
}

export function appendDeprecationPolicyLink(headers: Headers): void {
  const existing = headers.get('Link');
  if (existing && DEPRECATION_REL.test(existing)) return;
  headers.set('Link', existing ? `${existing}, ${DEPRECATION_POLICY_LINK}` : DEPRECATION_POLICY_LINK);
}
