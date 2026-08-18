/**
 * Query-param namespaces reserved for OUR OWN internal source tags.
 *
 * `?ref=` and `?wm_referral=` are affiliate attribution: the dashboard
 * persists the value for 7 days and forwards it to Dodo as
 * `affonso_referral`, crediting — and paying — a sharer for the purchase.
 * Internal CTAs are supposed to tag with `utm_*` instead (Umami reads
 * those natively, referral capture ignores them); see
 * docs/solutions/conventions/ref-param-is-affiliate-attribution-use-utm-for-internal-source-tags.md.
 *
 * The welcome landing page nevertheless shipped `?ref=welcome-*` on its
 * dashboard CTAs for months (#6493), so ordinary internal navigation minted
 * fake affiliate codes. Fixing the links does not un-poison the visitors who
 * already clicked them: their code sits in localStorage with up to 7 days
 * left to run, and bookmarks, shared URLs and cached HTML keep sending the
 * old params. This is the runtime backstop for that.
 *
 * It lives in `shared/` because BOTH apps mint referral codes from a URL —
 * the dashboard (`src/services/referral-capture.ts`) and the `/pro`
 * marketing page (`pro-test/src/App.tsx`) — and each one reaches the same
 * checkout. Hardening only one leaves the other as a live path for the exact
 * bug this closes.
 */

export const INTERNAL_SOURCE_TAG_PREFIXES = ['welcome', 'seo'] as const;

/**
 * True when a referral value is one of our internal source tags rather than
 * a sharer's affiliate code.
 *
 * Matches the bare namespace (`welcome`, `seo`) and anything under it
 * (`welcome-hero`, `seo-country`), case-insensitively. It deliberately does
 * NOT match a code that merely contains the word — `welcomehero` and
 * `partner-welcome-x` stay valid affiliate codes, because the reserved thing
 * is the namespace, not the substring.
 */
export function isInternalSourceTag(code: string): boolean {
  if (typeof code !== 'string') return false;
  const normalized = code.toLowerCase();
  return INTERNAL_SOURCE_TAG_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}-`)
  );
}
