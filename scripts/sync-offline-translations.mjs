#!/usr/bin/env node
/**
 * Regenerate the inline translation table inside public/offline.html from
 * src/locales/<lng>.json `shell.offlineTitle` / `shell.offlineMessage` /
 * `shell.offlineRetry`. The offline page is served by the service worker with
 * no JS bundle, so it can't reuse i18next at runtime — its translations have
 * to be inlined ahead of time.
 *
 * Run after:
 *   - editing the EN offline.* strings in src/locales/en.json
 *   - running scripts/translate-locales.mjs to backfill non-English locales
 *   - adding a new supported locale
 *
 * Exits non-zero if any locale is missing all 3 offline.* keys (so CI can
 * gate on it).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const LOCALES = ['en', 'ar', 'bg', 'cs', 'de', 'el', 'es', 'fr', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'ro', 'ru', 'sv', 'th', 'tr', 'vi', 'zh'];
const OFFLINE_HTML = 'public/offline.html';
const LOCALES_DIR = 'src/locales';

const START = '      var T = {';
const END = '      };';

function escJs(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildTable() {
  const rows = [];
  let missing = 0;
  for (const loc of LOCALES) {
    const j = JSON.parse(readFileSync(path.join(LOCALES_DIR, `${loc}.json`), 'utf8'));
    const s = j.shell || {};
    const title = s.offlineTitle;
    const msg = s.offlineMessage;
    const retry = s.offlineRetry;
    if (!title || !msg || !retry) {
      console.error(`[sync-offline] ${loc}: missing one of shell.offlineTitle / offlineMessage / offlineRetry`);
      missing++;
      continue;
    }
    rows.push(`        ${loc}: { title: "${escJs(title)}", msg: "${escJs(msg)}", retry: "${escJs(retry)}" }`);
  }
  return { body: rows.join(',\n'), missing };
}

const html = readFileSync(OFFLINE_HTML, 'utf8');
const startIdx = html.indexOf(START);
const endIdx = html.indexOf(END, startIdx);
if (startIdx < 0 || endIdx < 0) {
  console.error(`[sync-offline] could not find table sentinels in ${OFFLINE_HTML}`);
  process.exit(1);
}

const { body, missing } = buildTable();
if (missing > 0) {
  console.error(`[sync-offline] FAIL — ${missing} locale(s) missing offline.* keys. Run translate-locales.mjs first.`);
  process.exit(1);
}

const next = html.slice(0, startIdx) + START + '\n' + body + '\n' + html.slice(endIdx);
writeFileSync(OFFLINE_HTML, next);
console.log(`[sync-offline] OK — wrote ${LOCALES.length} locales into ${OFFLINE_HTML}`);
