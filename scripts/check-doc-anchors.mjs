#!/usr/bin/env node
/**
 * Fail on a doc anchor that points at no heading — on its own page or on
 * another exported page.
 *
 * Nothing else catches this. `scripts/enforce-mintlify-reserved-slugs.mjs`
 * only guards Mintlify's reserved /mcp slug, `mint validate` passes in strict
 * mode with dead anchors present, and `mint broken-links` checks page links
 * and never fragments. So a translated page can keep linking to its English
 * slugs indefinitely, which is exactly what happened to docs/zh/mcp-overview.
 *
 * Cross-page fragments are checked too, and they are where the survivors hid:
 * the in-page pass alone reported OK over a tree holding 36 dead `/page#frag`
 * links, including the very slug a same-page link had just been repaired to.
 * A fragment is only resolved when its target page is in the export; anything
 * outside it (external hosts, non-exported paths) is counted and skipped,
 * because this checker can only speak for pages it can read.
 *
 * Ground truth is the RENDERED export, never a slug function of our own.
 * Mintlify's slug rules are not reproducible by inspection: it strips ASCII
 * parentheses (`Daily limit (Pro tier)` -> `daily-limit-pro-tier`) but keeps
 * full-width ones (`每日额度（Pro 套餐）` -> `每日额度（pro-套餐）`), and keeps `&`
 * and em-dashes (`Plans & limits` -> `plans-&-limits`, `Annex 1 — Details` ->
 * `annex-1--details`) where GitHub's slugger drops them. A near-miss
 * reimplementation would emit false failures, which is worse than the gap it
 * closes, so this reads the ids Mintlify actually emitted.
 *
 * Usage:
 *   mint export --output export.zip     # run in docs/
 *   unzip -q export.zip -d export/
 *   node scripts/check-doc-anchors.mjs export/
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { decodeHtmlEntities } from './_html-entities.mjs';

const root = process.argv[2];
if (!root) {
  console.error('usage: node scripts/check-doc-anchors.mjs <unpacked-export-dir>');
  process.exit(2);
}

// Anchors the platform owns rather than the author: Mintlify emits React
// scroll targets and synthetic layout ids that no .mdx heading declares.
// Every alternative is end-anchored except the `_R_` React prefix, which
// carries a generated suffix. An unanchored `footer` would also swallow an
// authored `#footer-notes` and report it as checked-and-fine.
const IGNORED = /^(?:_R_|(?:page-title|content-area|navbar|sidebar|footer|header|content|content-container)$)/;

const decode = (raw) => {
  let value = raw;
  try {
    value = decodeURIComponent(value);
  } catch {
    /* keep raw when not percent-encoded */
  }
  return decodeHtmlEntities(value);
};

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

const pageOf = (file) => relative(root, file).split(sep).slice(0, -1).join('/');

// First pass: every page's ids, so a cross-page fragment can be resolved
// against the page it actually names.
const idsByPage = new Map();
const sources = new Map();
for (const file of htmlFiles) {
  const doc = readFileSync(file, 'utf8');
  sources.set(file, doc);
  idsByPage.set(pageOf(file), new Set([...doc.matchAll(/id="([^"]+)"/g)].map((m) => decodeHtmlEntities(m[1]))));
}

// The renderer that assigns these ids is downloaded at export time and is NOT
// the version pinned in CI, so a slugging change can arrive with no repo
// change. This canary asserts the RULE rather than the content: if the heading
// still reads "Plans & limits", its id must still keep the ampersand. Renaming
// the heading retires the canary; changing how Mintlify slugs reds it.
const canaryDoc = sources.get(join(root, 'mcp-overview', 'index.html'));
if (canaryDoc) {
  const heading = canaryDoc.match(/<h[1-6][^>]*\sid="([^"]+)"[^>]*>(?:(?!<\/h[1-6]>)[\s\S]){0,4000}?Plans &amp; limits/);
  if (heading && decodeHtmlEntities(heading[1]) !== 'plans-&-limits') {
    console.error(
      `Slug rules changed under us: "Plans & limits" now renders as id="${decodeHtmlEntities(heading[1])}", not "plans-&-limits".\n`
      + 'Mintlify downloads its renderer at export time, so the npm pin in the workflow does not hold it.\n'
      + 'Re-measure the affected anchors against a fresh export before trusting this gate again.',
    );
    process.exit(2);
  }
}

let checked = 0;
let skippedOffExport = 0;
const failures = [];

for (const file of htmlFiles) {
  const doc = sources.get(file);
  const page = pageOf(file) || '(root)';
  const ownIds = idsByPage.get(pageOf(file));

  const inPage = new Set([...doc.matchAll(/href="#([^"]+)"/g)].map((m) => decode(m[1])));
  for (const href of inPage) {
    if (IGNORED.test(href)) continue;
    checked++;
    if (!ownIds.has(href)) failures.push({ page, target: `#${href}` });
  }

  const crossPage = new Set(
    [...doc.matchAll(/href="(\/[^"#?]*)(?:\?[^"#]*)?#([^"]+)"/g)]
      .map((m) => `${decode(m[1]).replace(/^\/+|\/+$/g, '')}#${decode(m[2])}`),
  );
  for (const entry of crossPage) {
    const cut = entry.indexOf('#');
    const path = entry.slice(0, cut);
    const href = entry.slice(cut + 1);
    if (IGNORED.test(href)) continue;
    // Only pages in this export can be spoken for.
    if (!idsByPage.has(path)) {
      skippedOffExport++;
      continue;
    }
    checked++;
    if (!idsByPage.get(path).has(href)) failures.push({ page, target: `/${path}#${href}` });
  }
}

if (failures.length > 0) {
  console.error(`Dead doc anchors: ${failures.length} of ${checked} checked\n`);
  for (const { page, target } of failures) console.error(`  /${page}  ->  ${target}`);
  console.error('\nThe heading it names does not exist on that page. A translated page');
  console.error('linking an English slug is the usual cause. Read the real id out of');
  console.error('the export rather than guessing the slug.');
  process.exit(1);
}

console.log(
  `check-doc-anchors OK — ${checked} anchors across ${htmlFiles.length} pages all resolve`
  + `${skippedOffExport > 0 ? ` (${skippedOffExport} pointed outside the export and were skipped)` : ''}.`,
);
