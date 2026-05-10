#!/usr/bin/env node
/**
 * Backfill missing locale strings using Claude Haiku as the translator.
 *
 * - Source of truth: src/locales/en.json (or pro-test/src/locales/en.json with --pro-test)
 * - Diffs each non-English locale against EN, sends only the missing keys
 *   in batches to Claude, deep-merges the response back into the locale file.
 * - Preserves i18next interpolation tokens (`{{name}}`, `<strong>`, emoji,
 *   numerals, URLs) verbatim — the model is instructed not to translate them.
 * - Idempotent: re-running on a fully-translated locale is a no-op.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/translate-locales.mjs
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/translate-locales.mjs --only=fr,de
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/translate-locales.mjs --pro-test
 *   node scripts/translate-locales.mjs --dry-run    # just report the gap
 *
 * Cost: ~8.3K strings × 20 locales backfill ≈ ~$3 on claude-haiku-4-5.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Anthropic } from '@anthropic-ai/sdk';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const proTest = args.has('--pro-test');
const onlyArg = [...args].find(a => a.startsWith('--only='));
const onlyLocales = onlyArg ? onlyArg.slice('--only='.length).split(',') : null;

const ROOT = proTest ? 'pro-test/src/locales' : 'src/locales';
const LOCALES = ['ar', 'bg', 'cs', 'de', 'el', 'es', 'fr', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'ro', 'ru', 'sv', 'th', 'tr', 'vi', 'zh'];
const LANG_NAMES = {
  ar: 'Arabic', bg: 'Bulgarian', cs: 'Czech', de: 'German', el: 'Greek',
  es: 'Spanish', fr: 'French', it: 'Italian', ja: 'Japanese', ko: 'Korean',
  nl: 'Dutch', pl: 'Polish', pt: 'Portuguese (Brazil)', ro: 'Romanian',
  ru: 'Russian', sv: 'Swedish', th: 'Thai', tr: 'Turkish', vi: 'Vietnamese',
  zh: 'Simplified Chinese',
};
const BATCH_SIZE = 50;
const MODEL = 'claude-haiku-4-5-20251001';

function flatten(obj, prefix = '', out = {}) {
  if (Array.isArray(obj)) {
    // Array elements get encoded with a `[N]` suffix so setNested can rebuild
    // the array shape on the receiving end. Required for things like pricing
    // tier `features` lists that i18next consumes via `returnObjects: true`.
    obj.forEach((item, i) => {
      const key = `${prefix}[${i}]`;
      if (typeof item === 'string') out[key] = item;
      else if (item && typeof item === 'object') flatten(item, key, out);
    });
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) flatten(v, key, out);
    else if (v && typeof v === 'object') flatten(v, key, out);
    else if (typeof v === 'string') out[key] = v;
  }
  return out;
}

function setNested(obj, dotted, value) {
  // Path tokens are either object keys (split on `.`) or array indices
  // (`name[3]`). Split into a flat token list with explicit string/number
  // typing so we can materialise arrays vs objects on demand.
  const tokens = [];
  for (const part of dotted.split('.')) {
    const m = part.match(/^([^\[]*)((?:\[\d+\])+)?$/);
    if (m && m[1]) tokens.push({ type: 'key', value: m[1] });
    if (m && m[2]) {
      for (const idx of m[2].matchAll(/\[(\d+)\]/g)) {
        tokens.push({ type: 'index', value: Number(idx[1]) });
      }
    }
  }
  let cur = obj;
  for (let i = 0; i < tokens.length - 1; i++) {
    const tok = tokens[i];
    const next = tokens[i + 1];
    const wantArray = next.type === 'index';
    if (tok.type === 'key') {
      if (!(tok.value in cur) || cur[tok.value] === null || (wantArray !== Array.isArray(cur[tok.value]))) {
        cur[tok.value] = wantArray ? [] : {};
      }
      cur = cur[tok.value];
    } else {
      if (cur[tok.value] === undefined || cur[tok.value] === null || (wantArray !== Array.isArray(cur[tok.value]))) {
        cur[tok.value] = wantArray ? [] : {};
      }
      cur = cur[tok.value];
    }
  }
  const last = tokens[tokens.length - 1];
  cur[last.value] = value;
}

async function translateBatch(client, langName, batch) {
  const items = batch.map(([k, v]) => `${k}\t${v}`).join('\n');
  const prompt = `You are a professional UI translator. Translate the following English UI strings to ${langName}.

CRITICAL RULES:
1. Preserve interpolation tokens EXACTLY as-is: {{count}}, {{name}}, {{tone}}, etc. — do NOT translate or move them.
2. Preserve HTML tags EXACTLY: <strong>, <br>, <em>, <li>, <ul>. Do NOT translate tag names.
3. Preserve emoji, numerals, URLs, and capitalisation style of acronyms (PRO, BREAKING, ALERT, AI, MCP, CII, RSS, ADS-B, AIS).
4. Preserve format (sentence case vs ALL CAPS) — section titles like "BREAKING & CONFIRMED" stay ALL CAPS in the target language too.
5. Output is tab-separated: one line per input, format: <key><TAB><translation>. NOTHING ELSE — no commentary, no quotes, no markdown.
6. Translate naturally for a software UI: concise, idiomatic, no over-formal phrasing.
7. For Arabic, use modern standard Arabic (MSA). For Chinese, use Simplified Chinese.

Input (key<TAB>english):
${items}

Output (key<TAB>${langName}):`;

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = res.content.filter(c => c.type === 'text').map(c => c.text).join('');

  const out = {};
  for (const line of text.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const k = line.slice(0, tab).trim();
    const v = line.slice(tab + 1);
    if (k && v) out[k] = v;
  }
  return out;
}

function validateTranslation(en, translated) {
  // Reject if interpolation tokens were dropped or invented
  const enTokens = (en.match(/\{\{[^}]+\}\}/g) || []).sort();
  const tTokens = (translated.match(/\{\{[^}]+\}\}/g) || []).sort();
  if (enTokens.join('|') !== tTokens.join('|')) return false;

  // Reject if HTML tags were dropped, renamed, or added. Compare the sorted
  // multiset (not the order) so paraphrased sentences with the same tag set
  // pass — but a stripped <strong> or invented <i> fails.
  const tagPattern = /<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s[^>]*)?>/g;
  const norm = s => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const enTags = (en.match(tagPattern) || []).map(norm).sort();
  const tTags = (translated.match(tagPattern) || []).map(norm).sort();
  if (enTags.join('|') !== tTags.join('|')) return false;

  return true;
}

async function main() {
  if (!dryRun && !process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set. Use --dry-run to see the gap without translating.');
    process.exit(1);
  }
  const client = dryRun ? null : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const enPath = path.join(ROOT, 'en.json');
  const enFlat = flatten(JSON.parse(readFileSync(enPath, 'utf8')));
  console.log(`[translate] EN source: ${enPath} (${Object.keys(enFlat).length} keys)`);

  const targets = onlyLocales || LOCALES;
  let totalMissing = 0;
  let totalTranslated = 0;
  let totalRejected = 0;

  for (const loc of targets) {
    const locPath = path.join(ROOT, `${loc}.json`);
    const raw = JSON.parse(readFileSync(locPath, 'utf8'));
    const flat = flatten(raw);
    const missing = Object.keys(enFlat).filter(k => !(k in flat));
    if (missing.length === 0) {
      console.log(`[${loc}] ✓ already complete`);
      continue;
    }
    console.log(`[${loc}] missing ${missing.length} keys (${LANG_NAMES[loc]})`);
    totalMissing += missing.length;
    if (dryRun) continue;

    let added = 0;
    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
      const batch = missing.slice(i, i + BATCH_SIZE).map(k => [k, enFlat[k]]);
      try {
        const translations = await translateBatch(client, LANG_NAMES[loc], batch);
        for (const [k, en] of batch) {
          const tr = translations[k];
          if (!tr) continue;
          if (!validateTranslation(en, tr)) {
            totalRejected++;
            continue;
          }
          setNested(raw, k, tr);
          added++;
        }
      } catch (err) {
        console.error(`[${loc}] batch ${i}-${i + batch.length} failed:`, err.message);
      }
      writeFileSync(locPath, JSON.stringify(raw, null, 2) + '\n');
      console.log(`[${loc}] progress ${Math.min(i + BATCH_SIZE, missing.length)}/${missing.length}`);
    }
    totalTranslated += added;
    console.log(`[${loc}] ✓ added ${added} translations`);
  }

  // Re-scan post-write to confirm full coverage. A partial run (rejections,
  // batch failures, model omissions) must surface as a non-zero exit so CI
  // and operators don't trust a half-finished locale set.
  let stillMissing = 0;
  if (!dryRun) {
    for (const loc of targets) {
      const flat = flatten(JSON.parse(readFileSync(path.join(ROOT, `${loc}.json`), 'utf8')));
      const left = Object.keys(enFlat).filter(k => !(k in flat));
      if (left.length > 0) {
        console.error(`[${loc}] ✗ still missing ${left.length} keys after run (e.g. ${left.slice(0, 3).join(', ')})`);
        stillMissing += left.length;
      }
    }
  }

  console.log(`\n[done] missing ${totalMissing}, translated ${totalTranslated}, rejected ${totalRejected}, still-missing-after-run ${stillMissing}`);
  if (totalRejected > 0 || stillMissing > 0) {
    console.error('\n[FAIL] Partial backfill — re-run translate-locales.mjs to fill remaining keys.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
