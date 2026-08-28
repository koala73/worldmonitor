/**
 * A downloadable legal document must not outlive the page it was made from.
 *
 * The EULA, Terms and Privacy Policy are published as PDFs at `/legal/*.pdf`
 * so procurement can file them (#5726 thread). That is only safe while the PDF
 * matches the page: a copy that keeps circulating after the wording moved is
 * worse than no copy, because it looks authoritative and is quietly wrong.
 *
 * `public/legal/manifest.json` records the version and the source digest each
 * PDF was built from. This runs that comparison without a browser, so it works
 * in the normal test job — the rendering step needs Playwright, the freshness
 * check does not.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LEGAL_DOCUMENT_DIGESTS, TERMS_VERSION } from '../shared/legal.ts';
import { digestLegalDocument } from '../scripts/legal-digests.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const manifest = JSON.parse(read('public/legal/manifest.json')) as {
  version: string;
  documents: Array<{ source: string; pdf: string; sourceDigest: string }>;
};

describe('published legal PDFs match the pages they came from', () => {
  it('covers exactly the documents a stamped version includes', () => {
    assert.deepEqual(
      manifest.documents.map((doc) => doc.source).sort(),
      Object.keys(LEGAL_DOCUMENT_DIGESTS).sort(),
      'every document under LEGAL_DOCUMENT_DIGESTS needs a PDF, and nothing else belongs in the manifest',
    );
  });

  it('was built for the version currently published', () => {
    assert.equal(
      manifest.version,
      TERMS_VERSION,
      `PDFs were built for ${manifest.version}; the documents now say ${TERMS_VERSION}. Run: node scripts/build-legal-pdfs.mjs`,
    );
  });

  for (const doc of manifest.documents) {
    it(`${doc.source} has not changed since its PDF was built`, () => {
      assert.equal(
        digestLegalDocument(join(ROOT, doc.source)),
        doc.sourceDigest,
        `${doc.source} moved after ${doc.pdf} was rendered. Run: node scripts/build-legal-pdfs.mjs`,
      );
    });

    it(`${doc.pdf} exists and is a real PDF`, () => {
      const file = join(ROOT, 'public', doc.pdf.replace(/^\/+/, ''));
      assert.ok(existsSync(file), `${doc.pdf} is missing`);
      assert.ok(statSync(file).size > 10_000, `${doc.pdf} is too small to be the rendered document`);
      // A truncated or half-written render is the failure a size check alone
      // would wave through.
      const bytes = readFileSync(file);
      assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-', `${doc.pdf} is not a PDF`);
      assert.ok(
        bytes.subarray(-1024).toString('latin1').includes('%%EOF'),
        `${doc.pdf} has no EOF marker — the render was cut short`,
      );
    });

    it(`${doc.source} tells a reader the PDF exists`, () => {
      // A download nobody is pointed at is the state this replaced: the .md
      // twin has been served all along and was never linked.
      assert.match(
        read(doc.source),
        new RegExp(`https://www\\.worldmonitor\\.app${doc.pdf.replace(/\./g, '\\.')}`),
        `${doc.source} must link its own PDF`,
      );
    });
  }

  it('the Chinese mirrors point at the authoritative English PDFs', () => {
    for (const doc of manifest.documents) {
      const zhPath = doc.source.replace(/^docs\//, 'docs/zh/');
      assert.ok(existsSync(join(ROOT, zhPath)), `${zhPath} missing`);
      assert.match(
        read(zhPath),
        new RegExp(`https://www\\.worldmonitor\\.app${doc.pdf.replace(/\./g, '\\.')}`),
        `${zhPath} must link the English PDF — translations are not the binding text`,
      );
    }
  });
});
