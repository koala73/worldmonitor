/**
 * A recorded `termsVersion` has to resolve to the text that was accepted.
 *
 * Replaces `tests/terms-version-archive.test.mts` (#6982), whose dated snapshot
 * pages were dropped for git history (owner decision, 2026-08-20). The archive
 * caught three failures; this keeps all three, the third by digest rather than
 * by body-for-body comparison against a snapshot:
 *
 *   1. A legal page edited without bumping "Last updated" — every user who
 *      accepted the old wording silently maps to text they never saw.
 *   2. A version bumped on one document but not its siblings — one stamped
 *      version names all three, so they have to agree.
 *   3. TERMS_VERSION drifting from the date the pages actually carry.
 *
 * What git history gives that a snapshot page did not: every version, not just
 * the ones someone remembered to archive, and the diff between any two.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { LEGAL_DOCUMENT_DIGESTS, TERMS_VERSION, legalHistoryUrl } from '../shared/legal.ts';
import { digestLegalDocument, normalizeLegalBody } from '../scripts/legal-digests.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** `_Last updated: 20 August 2026_` → `2026-08-20`. */
function readLastUpdatedIso(mdx: string, label: string): string {
  const match = mdx.match(/^_Last updated:\s*(\d{1,2})\s+([A-Z][a-z]+)\s+(\d{4})_$/m);
  assert.ok(match, `${label} must carry a "_Last updated: D Month YYYY_" line`);
  const [, day, month, year] = match;
  const monthIndex = MONTHS.indexOf(month);
  assert.ok(monthIndex >= 0, `${label} has an unrecognized month: ${month}`);
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${day.padStart(2, '0')}`;
}

const documents = Object.keys(LEGAL_DOCUMENT_DIGESTS);

describe('legal version ↔ published text', () => {
  it('covers every published legal document', () => {
    assert.deepEqual(documents, ['docs/eula.mdx', 'docs/terms.mdx', 'docs/dpa.mdx', 'docs/privacy.mdx']);
  });

  it('the checkout acceptance set is the three a buyer actually accepts', () => {
    // All four share a version so a countersigned DPA can be matched to the
    // text it was signed against. Only three are recorded by a checkout
    // acceptance — the DPA is entered separately by customers who need it, and
    // claiming a buyer accepted it at a Subscribe button would be false.
    const accepted = documents.filter((doc) => doc !== 'docs/dpa.mdx');
    assert.deepEqual(accepted, ['docs/eula.mdx', 'docs/terms.mdx', 'docs/privacy.mdx']);
    assert.match(
      readFileSync(join(ROOT, 'docs/dpa.mdx'), 'utf8'),
      /You do not need to sign anything for this DPA to apply/i,
      'a DPA that needs a signature nobody can obtain is the blocker this replaced',
    );
  });

  it('TERMS_VERSION is an ISO date', () => {
    assert.match(TERMS_VERSION, /^\d{4}-\d{2}-\d{2}$/);
  });

  for (const doc of documents) {
    it(`${doc} carries the stamped version as its date`, () => {
      const text = readFileSync(join(ROOT, doc), 'utf8');
      assert.equal(
        readLastUpdatedIso(text, doc),
        TERMS_VERSION,
        `${doc} drifted from TERMS_VERSION — the accepted set must share one date`,
      );
    });

    it(`${doc} matches the digest recorded for it`, () => {
      assert.equal(
        digestLegalDocument(join(ROOT, doc)),
        LEGAL_DOCUMENT_DIGESTS[doc],
        `${doc} changed without a version bump. Bump the date and TERMS_VERSION, then run: node scripts/legal-digests.mjs`,
      );
    });
  }

  it('every recorded digest is populated', () => {
    for (const [doc, digest] of Object.entries(LEGAL_DOCUMENT_DIGESTS)) {
      assert.match(digest, /^[0-9a-f]{64}$/, `${doc} has no digest — run: node scripts/legal-digests.mjs`);
    }
  });

  it('an edit to the visible body changes the digest', () => {
    // Positive control. Without it, a normalizer that stripped too much would
    // leave every assertion above passing against a constant hash.
    const original = readFileSync(join(ROOT, 'docs/terms.mdx'), 'utf8');
    const edited = original.replace(
      '## Governing law',
      '## Governing law\n\nWe may assign these Terms to any acquirer without notice.',
    );
    assert.notEqual(edited, original, 'expected the fixture edit to apply');
    assert.notEqual(
      normalizeLegalBody(edited),
      normalizeLegalBody(original),
      'a new clause must survive normalization — otherwise the digest guard is blind',
    );
  });

  it('an editorial note does not change the digest', () => {
    // The other half of the control: review comments and frontmatter are
    // excluded on purpose, so a note never forces a version bump.
    const original = readFileSync(join(ROOT, 'docs/terms.mdx'), 'utf8');
    const annotated = original.replace(
      '_Last updated:',
      '{/* REVIEW — counsel pass scheduled */}\n\n_Last updated:',
    );
    assert.equal(normalizeLegalBody(annotated), normalizeLegalBody(original));
  });

  it('points a reader at the history that holds previous versions', () => {
    assert.equal(
      legalHistoryUrl('docs/terms.mdx'),
      'https://github.com/koala73/worldmonitor/commits/main/docs/terms.mdx',
    );
    for (const doc of ['docs/terms.mdx', 'docs/eula.mdx']) {
      const text = readFileSync(join(ROOT, doc), 'utf8');
      assert.ok(
        text.includes(legalHistoryUrl(doc)),
        `${doc} must link its own history — that link is the archive`,
      );
    }
  });
});
