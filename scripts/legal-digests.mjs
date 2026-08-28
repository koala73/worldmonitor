#!/usr/bin/env node
/**
 * Regenerate `LEGAL_DOCUMENT_DIGESTS` in shared/legal.ts.
 *
 * Git history is the archive (owner decision, 2026-08-20), which resolves any
 * recorded `termsVersion` to real text — but only catches the failures a human
 * would notice. The one it cannot catch is the silent one: a legal page edited
 * without bumping its date, which remaps every existing acceptance onto wording
 * nobody agreed to. The digests close that hole.
 *
 * Run after any deliberate change to a legal page, together with the date and
 * TERMS_VERSION bump:
 *   node scripts/legal-digests.mjs             # rewrite the digests
 *   node scripts/legal-digests.mjs --check     # fail if any digest is stale
 *   node scripts/legal-digests.mjs --same-day  # republish under today's version
 *
 * `--same-day` exists because the version IS the publication date, so a second
 * change on the same day republishes under a version that was already live.
 * Anyone who accepted the earlier text that day has a record pointing at
 * wording that later moved. That is sometimes the right call — a correction
 * hours after publication, before real acceptance volume — but it must be a
 * decision, not a side effect of re-running this script.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LEGAL_TS = join(ROOT, 'shared', 'legal.ts');
const CHECK = process.argv.includes('--check');
const SAME_DAY = process.argv.includes('--same-day');

/**
 * The body a reader is bound by: frontmatter (title/description metadata) and
 * MDX review comments are stripped, so an editorial note or an SEO description
 * tweak does not force a version bump, while any change to the visible text
 * does.
 */
export function normalizeLegalBody(mdx) {
  return mdx
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function digestLegalDocument(absolutePath) {
  return createHash('sha256').update(normalizeLegalBody(readFileSync(absolutePath, 'utf8')), 'utf8').digest('hex');
}

/** The version those digests are recorded against. */
export function currentVersion(source = readFileSync(LEGAL_TS, 'utf8')) {
  return source.match(/TERMS_VERSION = '([^']+)'/)?.[1] ?? '(unknown)';
}

/** The doc paths declared in shared/legal.ts, in source order. */
export function declaredLegalDocuments(source = readFileSync(LEGAL_TS, 'utf8')) {
  const block = source.match(/LEGAL_DOCUMENT_DIGESTS[^{]*\{([\s\S]*?)\n\};/);
  if (!block) throw new Error('LEGAL_DOCUMENT_DIGESTS not found in shared/legal.ts');
  return [...block[1].matchAll(/'([^']+)':\s*'([0-9a-f]*)'/g)].map(([, path, digest]) => ({ path, digest }));
}

function main() {
  const source = readFileSync(LEGAL_TS, 'utf8');
  const declared = declaredLegalDocuments(source);
  const current = declared.map(({ path }) => ({ path, digest: digestLegalDocument(join(ROOT, path)) }));

  const stale = declared.filter((entry, index) => entry.digest !== current[index].digest);

  if (CHECK) {
    if (stale.length > 0) {
      console.error(
        `Legal document digests are stale:\n${stale
          .map((entry) => `  ${entry.path}`)
          .join('\n')}\n\n` +
          'A legal page changed. Bump its "_Last updated:_" date AND TERMS_VERSION in\n' +
          'shared/legal.ts, then run: node scripts/legal-digests.mjs',
      );
      process.exit(1);
    }
    console.log(`Legal digests OK — ${declared.length} documents unchanged.`);
    return;
  }

  // A digest that was already recorded and has now moved means the published
  // text changed. If the version did not change with it, the new text is going
  // out under a version that is already in acceptance records.
  const republished = stale.filter((entry) => entry.digest.length > 0);
  if (republished.length > 0 && !SAME_DAY) {
    console.error(
      `These documents changed but the version did not:\n${republished
        .map((entry) => `  ${entry.path}`)
        .join('\n')}\n\n` +
        `Anyone who accepted version ${currentVersion(source)} already has a record pointing at the\n` +
        'earlier wording. Either bump the "_Last updated:_" date and TERMS_VERSION, or, if this is a\n' +
        'same-day correction you accept, re-run with --same-day.',
    );
    process.exit(1);
  }

  let updated = source;
  for (const { path, digest } of current) {
    const pattern = new RegExp(`('${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}':\\s*')[0-9a-f]*(')`);
    updated = updated.replace(pattern, `$1${digest}$2`);
  }
  writeFileSync(LEGAL_TS, updated, 'utf8');
  console.log(`Updated ${current.length} legal digests in shared/legal.ts`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
