/**
 * Canonical legal-document identity, shared by every app that has to show or
 * record it: the dashboard (`src/`), the /pro marketing app (`pro-test/`), and
 * Convex (`convex/users.ts`, which stamps the accepted version onto the user
 * record).
 *
 * Pure data — no DOM, no Node, no Convex imports — so all three roots can take
 * it. `pro-test/` reaches it by relative path (its Vite root has no `shared`
 * alias); `src/` and `convex/` likewise.
 *
 * TERMS_VERSION is the "Last updated" date on `docs/terms.mdx`, in ISO form.
 * It is the value written to `users.termsVersion`, so it MUST resolve to text
 * that still exists: every version names an archived snapshot under
 * `docs/legal/`. `tests/terms-version-archive.test.mts` holds those three
 * things together — the constant, the date on the page, and the archive file.
 * Bumping the Terms is therefore a three-part edit, deliberately.
 */

/** ISO date of the current Terms. Mirrors `_Last updated:_` in docs/terms.mdx. */
export const TERMS_VERSION = '2026-07-27';

export const TERMS_PATH = '/docs/terms';
export const PRIVACY_PATH = '/docs/privacy';
export const LICENSE_PATH = '/docs/license';
export const TRADEMARK_PATH = '/docs/trademark-policy';

/**
 * The legal cluster every footer carries. A browsewrap ("by using the Service
 * you agree…") is only as enforceable as the link it depends on, and #6976
 * found that link missing from both production footers and the dashboard.
 */
export const LEGAL_FOOTER_LINKS: ReadonlyArray<{ label: string; path: string }> = [
  { label: 'Terms', path: TERMS_PATH },
  { label: 'Privacy', path: PRIVACY_PATH },
  { label: 'License', path: LICENSE_PATH },
  { label: 'Trademark', path: TRADEMARK_PATH },
];

/**
 * Pre-payment assent copy, in parts, so the DOM builders in `src/` and the JSX
 * in `pro-test/` render the same sentence with real anchors rather than two
 * hand-written near-copies. English literals on purpose: adding `t()` keys here
 * would trip the shell-namespace byte budget for a line that must never fail to
 * render.
 */
export const CHECKOUT_CONSENT_LEAD = 'By subscribing you agree to the';
export const CHECKOUT_CONSENT_TERMS_LABEL = 'Terms of Service';
export const CHECKOUT_CONSENT_CONJUNCTION = 'and';
export const CHECKOUT_CONSENT_PRIVACY_LABEL = 'Privacy Policy';

/** Plain-text form, for anywhere that cannot host anchors (aria labels, tests). */
export const CHECKOUT_CONSENT_TEXT =
  `${CHECKOUT_CONSENT_LEAD} ${CHECKOUT_CONSENT_TERMS_LABEL} ${CHECKOUT_CONSENT_CONJUNCTION} ${CHECKOUT_CONSENT_PRIVACY_LABEL}.`;

/** docs.json page path of an archived Terms snapshot (no extension, no /docs). */
export function termsArchiveDocPath(version: string = TERMS_VERSION): string {
  return `legal/terms-${version}`;
}

/** Browser-facing URL of an archived Terms snapshot. */
export function termsArchiveUrl(version: string = TERMS_VERSION): string {
  return `/docs/${termsArchiveDocPath(version)}`;
}

/**
 * Absolute variants for surfaces that are not served from the web origin —
 * chiefly the Tauri desktop runtime, where a root-relative `/docs/terms`
 * resolves inside the WebView bundle and 404s.
 */
export function absoluteLegalUrl(path: string, origin: string): string {
  return `${origin.replace(/\/+$/, '')}${path}`;
}
