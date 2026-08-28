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
 * TERMS_VERSION is the "Last updated" date the legal documents carry, in ISO
 * form. It is the value written to `users.termsVersion`, so it MUST resolve to
 * text that still exists: git history is the archive, and the digests below
 * make an unbumped edit fail loudly. `tests/legal-version.test.mts` holds the
 * three together — the constant, the date on each page, and the body digest.
 */

/**
 * ISO date of the current legal documents, and the value stamped onto
 * `users.termsVersion`. The EULA, the Terms and the Privacy Policy are accepted
 * together and therefore carry ONE date — `tests/legal-version.test.mts`
 * enforces that they agree, so a single stamped version names all three.
 */
export const TERMS_VERSION = '2026-08-20';

/** The licence itself: what each plan grants, on every surface (#6983). */
export const EULA_PATH = '/docs/eula';
export const TERMS_PATH = '/docs/terms';
export const PRIVACY_PATH = '/docs/privacy';
/** Data Processing Addendum — entered separately by customers who need one. */
export const DPA_PATH = '/docs/dpa';
export const LICENSE_PATH = '/docs/license';
export const TRADEMARK_PATH = '/docs/trademark-policy';

/**
 * The legal cluster every footer carries. A browsewrap ("by using the Service
 * you agree…") is only as enforceable as the link it depends on, and #6976
 * found that link missing from both production footers and the dashboard.
 *
 * The EULA leads: it is the instrument that states what a plan grants and what
 * it forbids. "Source license" rather than "License" for the AGPL page, because
 * two entries reading "License …" side by side is exactly the ambiguity the
 * split between code licence and service licence needs to avoid.
 */
export const LEGAL_FOOTER_LINKS: ReadonlyArray<{ label: string; path: string }> = [
  { label: 'License agreement', path: EULA_PATH },
  { label: 'Terms', path: TERMS_PATH },
  { label: 'Privacy', path: PRIVACY_PATH },
  { label: 'Source license', path: LICENSE_PATH },
  { label: 'Trademark', path: TRADEMARK_PATH },
];

/**
 * Every published legal document, with the SHA-256 of its normalized body.
 *
 * All four share one version. Three of them — the EULA, the Terms and the
 * Privacy Policy — are what a checkout acceptance records. The DPA is entered
 * separately by customers who need one, and is versioned with them so a
 * customer holding a countersigned copy can tell which text it matches.
 *
 * This is what replaces dated archive pages (owner decision, 2026-08-20: git
 * history is the archive). A history link alone cannot catch the failure that
 * matters — a body edited without bumping the date, which silently remaps every
 * existing acceptance onto text nobody agreed to. The digest catches it: edit
 * the body, and `tests/legal-version.test.mts` fails until the version is
 * bumped and the digest regenerated with `npm run legal:digests`.
 *
 * Normalized = frontmatter and MDX review comments stripped, trailing
 * whitespace collapsed, so editorial notes do not force a version bump.
 */
export const LEGAL_DOCUMENT_DIGESTS: Readonly<Record<string, string>> = {
  'docs/eula.mdx': '2ddc65dcd32ad351ed705ba66ebe028665e84c7e061a50258b26c98805c8036e',
  'docs/terms.mdx': 'e398e283f9eee4de84d0f4de005c90ed009ec54255a3445d4fb37a0846fd85d0',
  'docs/dpa.mdx': 'd0b0d5d1a9583700ea09a6dc733cc1efa479aca802ad3a79bc0618c7c4537be1',
  'docs/privacy.mdx': '33c599b5ad2b9431374639fa843784d17289954f1f921746178467793696e020',
};

/** Where the text behind any recorded version can be read back. */
export function legalHistoryUrl(docPath: string): string {
  return `https://github.com/koala73/worldmonitor/commits/main/${docPath}`;
}

/**
 * Pre-payment assent copy, in parts, so the DOM builders in `src/` and the JSX
 * in `pro-test/` render the same sentence with real anchors rather than two
 * hand-written near-copies. English literals on purpose: adding `t()` keys here
 * would trip the shell-namespace byte budget for a line that must never fail to
 * render.
 */
export const CHECKOUT_CONSENT_LEAD = 'By subscribing you agree to the';
/**
 * Points at the EULA, not the Terms: the licence is the document carrying the
 * plan scopes, the seat rules and the redistribution limits a buyer is agreeing
 * to, and its section 2 links the Terms in turn. A clickwrap that names the
 * wrong document is the one clause a reviewer will pull on.
 */
export const CHECKOUT_CONSENT_LICENSE_LABEL = 'License Agreement';
export const CHECKOUT_CONSENT_CONJUNCTION = 'and';
export const CHECKOUT_CONSENT_PRIVACY_LABEL = 'Privacy Policy';

/** Plain-text form, for anywhere that cannot host anchors (aria labels, tests). */
export const CHECKOUT_CONSENT_TEXT =
  `${CHECKOUT_CONSENT_LEAD} ${CHECKOUT_CONSENT_LICENSE_LABEL} ${CHECKOUT_CONSENT_CONJUNCTION} ${CHECKOUT_CONSENT_PRIVACY_LABEL}.`;

/**
 * Absolute variants for surfaces that are not served from the web origin —
 * chiefly the Tauri desktop runtime, where a root-relative `/docs/terms`
 * resolves inside the WebView bundle and 404s.
 */
export function absoluteLegalUrl(path: string, origin: string): string {
  return `${origin.replace(/\/+$/, '')}${path}`;
}
