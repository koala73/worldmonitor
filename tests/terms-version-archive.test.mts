/**
 * A recorded `termsVersion` has to resolve to real text (#6976).
 *
 * `convex/users.ts` stamps `termsVersion: TERMS_VERSION` on every acceptance,
 * so the constant is only as good as the published page it names. Three ways
 * that link breaks, all of them silent in production:
 *
 *   1. Someone edits `docs/terms.mdx` without bumping "Last updated" — every
 *      user who accepted the old wording now maps to text they never saw.
 *   2. Someone bumps "Last updated" without archiving the outgoing text — the
 *      previous `termsVersion` values now resolve to nothing.
 *   3. `TERMS_VERSION` drifts from the date the page actually carries.
 *
 * The archived snapshot is compared body-for-body against the live Terms, so
 * (1) is caught too: any substantive edit fails here until it is paired with a
 * new date AND a new archive file.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { TERMS_VERSION, termsArchiveDocPath, termsArchiveUrl } from '../shared/legal.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DOCS_DIR = join(ROOT, 'docs');
const LIVE_TERMS = join(DOCS_DIR, 'terms.mdx');

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** `_Last updated: 27 July 2026_` → `2026-07-27`. */
function readLastUpdatedIso(mdx: string): string {
  const match = mdx.match(/^_Last updated:\s*(\d{1,2})\s+([A-Z][a-z]+)\s+(\d{4})_$/m);
  assert.ok(match, 'terms.mdx must carry a `_Last updated: D Month YYYY_` line');
  const [, day, month, year] = match;
  const monthIndex = MONTHS.indexOf(month);
  assert.ok(monthIndex >= 0, `unrecognized month name in "Last updated": ${month}`);
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/**
 * The clauses are what has to match, not the wrapper. Dropped from both sides:
 * frontmatter, MDX comments, blank-line churn, the archive's `<Note>` banner,
 * and the `## Previous versions` section — that index is navigation the live
 * page grows with each release, and an archived snapshot must not list itself.
 */
const ARCHIVE_BOUNDARY = '## Previous versions';
/**
 * Excises exactly the index section, heading through the next `## `. Splitting
 * on the heading instead would drop the whole tail of the document, and a
 * clause appended after it would compare equal to an archive that never had it
 * — the first draft of this test did exactly that and let a mutation through.
 * `it('the version index is not the last section')` keeps the lookahead fed.
 */
const ARCHIVE_INDEX_SECTION = /^## Previous versions\n[\s\S]*?(?=^## )/m;

function normalizeBody(mdx: string): string {
  return mdx
    .replace(ARCHIVE_INDEX_SECTION, '')
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/<Note>[\s\S]*?<\/Note>/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('\n');
}

const liveTerms = readFileSync(LIVE_TERMS, 'utf8');

describe('terms version ↔ archive', () => {
  it('TERMS_VERSION is an ISO date', () => {
    assert.match(TERMS_VERSION, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('TERMS_VERSION matches the "Last updated" date on the live Terms', () => {
    assert.equal(
      TERMS_VERSION,
      readLastUpdatedIso(liveTerms),
      'shared/legal.ts TERMS_VERSION drifted from docs/terms.mdx "Last updated"',
    );
  });

  it('the archived snapshot for TERMS_VERSION exists', () => {
    const archive = join(DOCS_DIR, `${termsArchiveDocPath(TERMS_VERSION)}.mdx`);
    assert.ok(
      existsSync(archive),
      `Missing ${archive}. Bumping the Terms means archiving the text that version names.`,
    );
  });

  it('the archived snapshot is the live text, clause for clause', () => {
    const archive = join(DOCS_DIR, `${termsArchiveDocPath(TERMS_VERSION)}.mdx`);
    const archived = readFileSync(archive, 'utf8');
    assert.equal(
      normalizeBody(archived),
      normalizeBody(liveTerms),
      'archived Terms body diverged from docs/terms.mdx — edit the Terms, bump the date, add a new archive',
    );
  });

  it('the archive URL is a docs path a footer or record can link', () => {
    assert.equal(termsArchiveUrl(TERMS_VERSION), `/docs/legal/terms-${TERMS_VERSION}`);
  });

  it('the live Terms index the archive so a reader can find prior versions', () => {
    const index = ARCHIVE_INDEX_SECTION.exec(liveTerms)?.[0] ?? '';
    assert.ok(
      index.includes(`/legal/terms-${TERMS_VERSION}`),
      'docs/terms.mdx needs a "## Previous versions" section listing every archived snapshot',
    );
  });

  it('the version index is not the last section, so the excision stays bounded', () => {
    const headings = [...liveTerms.matchAll(/^## .+$/gm)].map(m => m[0]);
    assert.notEqual(
      headings.at(-1),
      ARCHIVE_BOUNDARY,
      `"${ARCHIVE_BOUNDARY}" must be followed by another "## " section — as the final heading it would `
        + 'swallow the rest of the file and let clause edits pass unnoticed',
    );
  });
});
