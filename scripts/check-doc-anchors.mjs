#!/usr/bin/env node
/**
 * Fail on an in-page anchor that points at no heading on its own page.
 *
 * Nothing else catches this. `scripts/enforce-mintlify-reserved-slugs.mjs`
 * only guards Mintlify's reserved /mcp slug, `mint validate` passes in strict
 * mode with dead anchors present, and `mint broken-links` checks page links
 * and never fragments. So a translated page can keep linking to its English
 * slugs indefinitely, which is exactly what happened to docs/zh/mcp-overview.
 *
 * Ground truth is the RENDERED export, never a slug function of our own.
 * Mintlify's slug rules are not reproducible by inspection: it strips ASCII
 * parentheses (`Daily limit (Pro tier)` -> `daily-limit-pro-tier`) but keeps
 * full-width ones (`每日额度（Pro 套餐）` -> `每日额度（pro-套餐）`), and keeps `&`
 * (`Plans & limits` -> `plans-&-limits`) where GitHub's slugger drops it. A
 * near-miss reimplementation would emit false failures, which is worse than
 * the gap it closes, so this reads the ids Mintlify actually emitted.
 *
 * Usage:
 *   mint export --output export.zip   # run in docs/
 *   node scripts/check-doc-anchors.mjs <unpacked-export-dir>
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('usage: node scripts/check-doc-anchors.mjs <unpacked-export-dir>');
  process.exit(2);
}

// Anchors the platform owns rather than the author: Mintlify emits React
// scroll targets and a synthetic page-title id that no .mdx heading declares.
const IGNORED = /^(_R_|page-title$|content-area$|navbar|sidebar|footer)/;

const htmlFiles = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (entry.endsWith('.html')) htmlFiles.push(full);
  }
};
walk(root);

if (htmlFiles.length === 0) {
  console.error(`no .html under ${root} — did the export unpack?`);
  process.exit(2);
}

const unescape = (s) => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));

let checked = 0;
const failures = [];

for (const file of htmlFiles) {
  const doc = readFileSync(file, 'utf8');
  const ids = new Set([...doc.matchAll(/id="([^"]+)"/g)].map((m) => unescape(m[1])));
  const hrefs = new Set(
    [...doc.matchAll(/href="#([^"]+)"/g)].map((m) => {
      let raw = m[1];
      try { raw = decodeURIComponent(raw); } catch { /* keep raw when not percent-encoded */ }
      return unescape(raw);
    }),
  );
  const page = relative(root, file).split(sep).slice(0, -1).join('/') || '(root)';
  for (const href of hrefs) {
    if (IGNORED.test(href)) continue;
    checked++;
    if (!ids.has(href)) failures.push({ page, href });
  }
}

if (failures.length > 0) {
  console.error(`Dead in-page anchors: ${failures.length} of ${checked} checked\n`);
  for (const { page, href } of failures) console.error(`  /${page}  ->  #${href}`);
  console.error('\nThe heading it names does not exist on that page. A translated page');
  console.error('linking an English slug is the usual cause. Read the real id out of');
  console.error('the export rather than guessing the slug.');
  process.exit(1);
}

console.log(`check-doc-anchors OK — ${checked} in-page anchors across ${htmlFiles.length} pages all resolve.`);
