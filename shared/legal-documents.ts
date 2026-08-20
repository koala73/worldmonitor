/**
 * The published legal documents and the version a user accepts.
 *
 * `version` is the date printed on the page ("_Last updated: ..._"), and it is
 * what gets stored on the user record at sign-up and at checkout. Git history
 * is the archive (decision, 2026-08-20): a stored version plus the repository
 * history resolves to the exact text that was accepted, so no separate dated
 * copy of each page is maintained.
 *
 * `tests/legal-documents.test.mjs` asserts every version here equals the date
 * in the corresponding .mdx. Editing a document without bumping its version —
 * which would silently record consent to text nobody agreed to — turns red.
 */

export const LEGAL_REPO_HISTORY_BASE =
  'https://github.com/koala73/worldmonitor/commits/main';

export type LegalDocumentId = 'eula' | 'terms' | 'privacy';

export interface LegalDocument {
  /** Path of the English source, relative to the repository root. */
  readonly source: string;
  /** Published path on www.worldmonitor.app. */
  readonly path: string;
  /** ISO date matching the "_Last updated:_" line in `source`. */
  readonly version: string;
}

export const LEGAL_DOCUMENTS: Record<LegalDocumentId, LegalDocument> = {
  eula: { source: 'docs/eula.mdx', path: '/docs/eula', version: '2026-08-20' },
  terms: { source: 'docs/terms.mdx', path: '/docs/terms', version: '2026-08-20' },
  privacy: { source: 'docs/privacy.mdx', path: '/docs/privacy', version: '2026-08-20' },
};

/**
 * The single string stored against a user's acceptance. The EULA is the
 * canonical instrument, and the Terms and Privacy Policy are accepted with it,
 * so one version covers the set — but only while they carry the same date,
 * which the test enforces.
 */
export const CURRENT_LEGAL_VERSION = LEGAL_DOCUMENTS.eula.version;

/** Where the text of a given version can be read back. */
export function legalDocumentHistoryUrl(id: LegalDocumentId): string {
  return `${LEGAL_REPO_HISTORY_BASE}/${LEGAL_DOCUMENTS[id].source}`;
}

/** Accepted shape of a stored version: an ISO calendar date. */
export const LEGAL_VERSION_RE = /^\d{4}-\d{2}-\d{2}$/;
