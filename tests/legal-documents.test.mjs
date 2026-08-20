/**
 * A recorded consent version has to resolve to the text that was consented to.
 *
 * We store `legalAcceptedVersion` on the user record and treat git history as
 * the archive, which only works while the version constant and the date printed
 * on the page agree. Editing a legal page without bumping the constant would
 * keep stamping the old version onto acceptances of new text — the failure this
 * file exists to make loud.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));

const MONTHS = {
  January: '01', February: '02', March: '03', April: '04', May: '05', June: '06',
  July: '07', August: '08', September: '09', October: '10', November: '11', December: '12',
};

// Parsed from shared/legal-documents.ts rather than imported: this file runs
// under plain `node --test` as well as tsx, and a TS import would restrict it
// to one runner.
function readLegalDocuments() {
  const source = readFileSync(join(root, 'shared/legal-documents.ts'), 'utf8');
  const entries = [...source.matchAll(
    /(\w+):\s*\{\s*source:\s*'([^']+)',\s*path:\s*'([^']+)',\s*version:\s*'([^']+)'\s*\}/g,
  )];
  assert.ok(entries.length >= 3, 'expected eula, terms and privacy entries');
  return entries.map(([, id, docSource, path, version]) => ({ id, source: docSource, path, version }));
}

/** "_Last updated: 20 August 2026_" -> "2026-08-20" */
function publishedDate(text, relativePath) {
  const match = text.match(/_Last updated:\s*(\d{1,2})\s+([A-Z][a-z]+)\s+(\d{4})_/);
  assert.ok(match, `${relativePath} must carry a "_Last updated: D Month YYYY_" line`);
  const [, day, month, year] = match;
  const monthNumber = MONTHS[month];
  assert.ok(monthNumber, `${relativePath} has an unparseable month: ${month}`);
  return `${year}-${monthNumber}-${day.padStart(2, '0')}`;
}

describe('legal document versions', () => {
  const documents = readLegalDocuments();

  for (const doc of documents) {
    it(`${doc.source} is published at the version recorded for it`, () => {
      const text = readFileSync(join(root, doc.source), 'utf8');
      assert.equal(
        publishedDate(text, doc.source),
        doc.version,
        `${doc.source} was edited without bumping its version in shared/legal-documents.ts`,
      );
    });
  }

  it('one stored version covers the accepted set', () => {
    const versions = new Set(documents.map((doc) => doc.version));
    assert.equal(
      versions.size,
      1,
      `the EULA, Terms and Privacy Policy are accepted together, so they must share a date — found ${[...versions].join(', ')}`,
    );
  });

  it('the EULA tells a reader where to find previous versions', () => {
    const eula = readFileSync(join(root, 'docs/eula.mdx'), 'utf8');
    assert.match(
      eula,
      /github\.com\/koala73\/worldmonitor\/commits\/main\/docs\/eula\.mdx/,
      'the EULA must link its own history — that link is the archive',
    );
  });
});
