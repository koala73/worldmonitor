#!/usr/bin/env node
/**
 * Render the legal documents to PDF at stable URLs.
 *
 * The EULA, Terms and Privacy Policy live as MDX inside Mintlify, which is fine
 * to read and useless to file: enterprise procurement wants a document it can
 * attach to a review ticket and archive, not a docs page. `/docs/eula.md` does
 * return markdown, but undiscoverably, rendered inline, and with Mintlify's
 * injected docs-index banner sitting above the agreement.
 *
 * So: one PDF per document, generated from the same MDX the site renders, at
 * `/legal/<name>.pdf`. Same source, so it cannot say something the page does
 * not.
 *
 * Staleness is the real risk — a PDF that keeps circulating after the page
 * moved is worse than no PDF. `public/legal/manifest.json` records the version
 * and the source digest each PDF was built from, `--check` compares that
 * against `LEGAL_DOCUMENT_DIGESTS`, and `tests/legal-pdf-freshness.test.mts`
 * runs that comparison in CI without needing a browser.
 *
 *   node scripts/build-legal-pdfs.mjs          # render (needs Playwright chromium)
 *   node scripts/build-legal-pdfs.mjs --check  # fail if a PDF is stale (no browser)
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { marked } from 'marked';

import { digestLegalDocument, normalizeLegalBody } from './legal-digests.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = join(ROOT, 'public', 'legal');
const MANIFEST = join(OUT_DIR, 'manifest.json');
const CHECK = process.argv.includes('--check');

/** Source of truth for which documents are covered and what version they carry. */
function legalConstants() {
  const source = readFileSync(join(ROOT, 'shared', 'legal.ts'), 'utf8');
  const version = source.match(/TERMS_VERSION = '([^']+)'/)?.[1];
  if (!version) throw new Error('TERMS_VERSION not found in shared/legal.ts');
  const block = source.match(/LEGAL_DOCUMENT_DIGESTS[^{]*\{([\s\S]*?)\n\};/);
  if (!block) throw new Error('LEGAL_DOCUMENT_DIGESTS not found in shared/legal.ts');
  const docs = [...block[1].matchAll(/'([^']+)':\s*'([0-9a-f]*)'/g)].map(([, path]) => path);
  return { version, docs };
}

/** `docs/eula.mdx` -> `eula` */
const slugOf = (docPath) => docPath.replace(/^docs\//, '').replace(/\.mdx$/, '');

function frontmatterTitle(mdx, fallback) {
  const fm = mdx.match(/^---\n([\s\S]*?)\n---/);
  const title = fm?.[1].match(/^title:\s*"?([^"\n]+)"?\s*$/m)?.[1];
  return (title ?? fallback).trim();
}

/**
 * Print-oriented, deliberately plain. This is a legal document: serif body for
 * long-form reading, real page margins, tables that survive a page break, and
 * the version stamped in the running footer so a printed copy can be matched
 * back to a recorded acceptance.
 */
function pageHtml({ title, bodyHtml, version, docPath }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
  @page { size: A4; margin: 20mm 18mm 22mm; }
  * { box-sizing: border-box; }
  body { font: 10.5pt/1.55 Georgia, 'Times New Roman', serif; color: #111; margin: 0; }
  h1 { font-size: 20pt; line-height: 1.25; margin: 0 0 4pt; }
  h2 { font-size: 13pt; margin: 18pt 0 6pt; padding-bottom: 3pt; border-bottom: 0.5pt solid #bbb; break-after: avoid; }
  h3 { font-size: 11.5pt; margin: 13pt 0 4pt; break-after: avoid; }
  p, li { orphans: 3; widows: 3; }
  ul, ol { padding-left: 16pt; }
  li { margin: 2pt 0; }
  a { color: #111; text-decoration: underline; }
  code { font: 9.5pt/1.4 'SF Mono', Menlo, Consolas, monospace; background: #f2f2f2; padding: 0 2pt; }
  table { width: 100%; border-collapse: collapse; margin: 8pt 0; font-size: 9pt; break-inside: auto; }
  th, td { border: 0.5pt solid #999; padding: 4pt 5pt; text-align: left; vertical-align: top; }
  th { background: #eee; font-weight: bold; }
  tr { break-inside: avoid; }
  thead { display: table-header-group; }
  blockquote { margin: 8pt 0; padding-left: 10pt; border-left: 2pt solid #ccc; color: #333; }
  .doc-meta { font-size: 8.5pt; color: #555; margin: 0 0 14pt; padding-bottom: 8pt; border-bottom: 0.5pt solid #ccc; }
  .doc-meta strong { color: #111; }
</style></head>
<body>
<h1>${title}</h1>
<p class="doc-meta">World Monitor · version <strong>${version}</strong> ·
Authoritative text: https://www.worldmonitor.app/${docPath.replace(/^docs\//, 'docs/').replace(/\.mdx$/, '')} ·
Previous versions: https://github.com/koala73/worldmonitor/commits/main/${docPath}</p>
${bodyHtml}
</body></html>`;
}

function readManifest() {
  if (!existsSync(MANIFEST)) return null;
  try {
    return JSON.parse(readFileSync(MANIFEST, 'utf8'));
  } catch {
    return null;
  }
}

function currentState() {
  const { version, docs } = legalConstants();
  return {
    version,
    documents: docs.map((docPath) => ({
      source: docPath,
      pdf: `/legal/${slugOf(docPath)}.pdf`,
      sourceDigest: digestLegalDocument(join(ROOT, docPath)),
    })),
  };
}

function check() {
  const manifest = readManifest();
  if (!manifest) {
    console.error('public/legal/manifest.json is missing. Run: node scripts/build-legal-pdfs.mjs');
    process.exit(1);
  }
  const expected = currentState();
  const problems = [];

  if (manifest.version !== expected.version) {
    problems.push(`version: PDFs built for ${manifest.version}, documents now say ${expected.version}`);
  }
  for (const doc of expected.documents) {
    const built = manifest.documents?.find((entry) => entry.source === doc.source);
    if (!built) {
      problems.push(`${doc.source}: no PDF has been built`);
      continue;
    }
    if (built.sourceDigest !== doc.sourceDigest) {
      problems.push(`${doc.source}: changed since its PDF was built`);
    }
    const file = join(ROOT, 'public', 'legal', `${slugOf(doc.source)}.pdf`);
    if (!existsSync(file) || statSync(file).size === 0) {
      problems.push(`${doc.source}: ${built.pdf} is missing or empty`);
    }
  }

  if (problems.length > 0) {
    console.error(`Legal PDFs are stale:\n${problems.map((p) => `  ${p}`).join('\n')}\n\nRun: node scripts/build-legal-pdfs.mjs`);
    process.exit(1);
  }
  console.log(`Legal PDFs OK — ${expected.documents.length} documents at version ${expected.version}.`);
}

async function build() {
  const { chromium } = await import('playwright');
  const expected = currentState();
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  try {
    for (const doc of expected.documents) {
      const mdx = readFileSync(join(ROOT, doc.source), 'utf8');
      const title = frontmatterTitle(mdx, slugOf(doc.source));
      // Same normalization the digest uses, so the PDF carries exactly the text
      // the digest is taken over — frontmatter and review notes excluded.
      const bodyHtml = marked.parse(normalizeLegalBody(mdx), { async: false });

      const page = await browser.newPage();
      await page.setContent(
        pageHtml({ title, bodyHtml, version: expected.version, docPath: doc.source }),
        { waitUntil: 'load' },
      );
      await page.pdf({
        path: join(OUT_DIR, `${slugOf(doc.source)}.pdf`),
        format: 'A4',
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: '<div></div>',
        footerTemplate:
          '<div style="width:100%;font:8pt Georgia,serif;color:#666;padding:0 18mm;display:flex;justify-content:space-between">'
          + `<span>World Monitor — version ${expected.version}</span>`
          + '<span class="pageNumber"></span></div>',
        margin: { top: '20mm', right: '18mm', bottom: '22mm', left: '18mm' },
      });
      await page.close();
      console.log(`  ${doc.pdf}`);
    }
  } finally {
    await browser.close();
  }

  // No timestamp on purpose: the manifest must only change when the documents
  // do, or every run churns the diff and the freshness signal goes with it.
  writeFileSync(MANIFEST, `${JSON.stringify(expected, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${expected.documents.length} legal PDFs at version ${expected.version}`);
}

if (CHECK) check();
else await build();
