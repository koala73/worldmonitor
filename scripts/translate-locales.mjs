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

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Anthropic } from '@anthropic-ai/sdk';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const proTest = args.has('--pro-test');
const onlyArg = [...args].find(a => a.startsWith('--only='));
const onlyLocales = onlyArg ? onlyArg.slice('--only='.length).split(',') : null;

const ROOT = proTest ? 'pro-test/src/locales' : 'src/locales';
const LOCALES = ['ar', 'bg', 'cs', 'de', 'el', 'es', 'fa', 'fr', 'hi', 'hr', 'hu', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'ro', 'ru', 'sv', 'th', 'tr', 'vi', 'zh'];
const LANG_NAMES = {
  ar: 'Arabic', bg: 'Bulgarian', cs: 'Czech', de: 'German', el: 'Greek',
  es: 'Spanish', fa: 'Persian (Farsi)', fr: 'French', hi: 'Hindi', hr: 'Croatian', hu: 'Hungarian', it: 'Italian', ja: 'Japanese',
  ko: 'Korean', nl: 'Dutch', pl: 'Polish', pt: 'Portuguese (Brazil)',
  ro: 'Romanian', ru: 'Russian', sv: 'Swedish', th: 'Thai', tr: 'Turkish',
  vi: 'Vietnamese', zh: 'Simplified Chinese',
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
    const m = part.match(/^([^[]*)((?:\[\d+\])+)?$/);
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
8. i18next plural variants: keys ending in _zero, _one, _two, _few, _many, or _other are CLDR plural forms of the same noun. Inflect the noun's morphology to match the CLDR plural category named by the suffix for the target locale, following the standard CLDR plural rules for that language (which include teen-case exceptions — do NOT use simplified "2-4" / "5+" rules of thumb; follow CLDR exactly). Safe per-suffix semantics that always hold: _one = singular form; _two = dual form (Arabic and a few others); _zero = the zero-count form (Arabic). Keep {{count}} in the translation even when the morphology itself encodes the count (i18next convention).

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

// Return the CLDR plural categories required for this locale. Driven by
// the V8-native Intl.PluralRules so adding a new locale to LOCALES picks up
// the right categories automatically — no per-locale lookup table to drift.
//   en/fr/de/...    → ['one','other']
//   ro              → ['one','few','other']
//   hr              → ['one','few','other']
//   cs/pl/ru        → ['one','few','many','other']
//   ar              → ['zero','one','two','few','many','other']
//   ja/ko/zh/vi/th  → ['other']
function getPluralCategories(loc) {
  try {
    // `?? ['one','other']` covers the case where pluralCategories itself is
    // absent (older Node where the property predates the spec) — the catch
    // block only fires on constructor throws (e.g. unknown locale tag), not
    // on a successful constructor that returns an options object without
    // the property. Without this guard the next `for (const cat of ...)`
    // throws TypeError mid-run.
    return new Intl.PluralRules(loc).resolvedOptions().pluralCategories ?? ['one', 'other'];
  } catch {
    return ['one', 'other'];
  }
}

// Identify pluralized "bases" in EN — keys where both `<base>_one` and
// `<base>_other` exist. EN only ever defines those two (English plural
// rules collapse everything else into _other), but the script will fan
// these out per-locale in expectedKeysForLocale().
function findPluralBases(enFlat) {
  const bases = new Map();
  for (const k of Object.keys(enFlat)) {
    const m = k.match(/^(.+)_(one|other)$/);
    if (!m) continue;
    const [, base, suffix] = m;
    if (!bases.has(base)) bases.set(base, {});
    bases.get(base)[suffix] = enFlat[k];
  }
  return new Map([...bases].filter(([, v]) => v.one && v.other));
}

// Build the set of keys we EXPECT this locale to have. For non-plural
// keys this is a 1:1 copy of EN. For pluralized bases, EN's `_one`/
// `_other` pair is expanded to one key per CLDR category the locale
// requires. The expected-value (the EN source) is `_one` for the `_one`
// slot, otherwise the `_other` form — which is the more representative
// "count != 1" sentence and the right morphological baseline for every
// non-one category the model is being asked to inflect.
// Convention: any dotted path segment that starts with `_` is a "private"
// translator-instruction key (e.g. `_methodologyLink_translatorNote` is a
// TODO note for human translators about its sibling `methodologyLink`).
// Such values are meant to remain in English so translators reading the
// raw locale files can understand them; sending them through the model
// has produced visible mistranslations (Arabic/Japanese/Portuguese/Thai
// translated the note text itself). Skip them here so they never enter
// either the missing-keys batch or the post-write coverage scan.
function isPrivateKey(k) {
  return k.split('.').some(seg => seg.startsWith('_'));
}

function expectedKeysForLocale(enFlat, pluralBases, categories) {
  const expected = {};
  const pluralEnKeys = new Set();
  for (const base of pluralBases.keys()) {
    pluralEnKeys.add(`${base}_one`);
    pluralEnKeys.add(`${base}_other`);
  }
  for (const [k, v] of Object.entries(enFlat)) {
    if (isPrivateKey(k)) continue;
    if (!pluralEnKeys.has(k)) expected[k] = v;
  }
  for (const [base, forms] of pluralBases) {
    if (isPrivateKey(base)) continue;
    for (const cat of categories) {
      expected[`${base}_${cat}`] = cat === 'one' ? forms.one : forms.other;
    }
  }
  return expected;
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

  // Reject if URLs/paths were dropped, rewritten, or added. Catches the case
  // where a methodologyLink value like `/docs/methodology/cii-risk-scores`
  // gets paraphrased away by an overconfident translation. Matches absolute
  // URLs (http(s)://...) and bare absolute paths whose FIRST segment starts
  // with a letter — that constraint avoids false positives on number
  // fractions like `50/100` or interpolation tokens like `{{count}}/{{total}}`
  // which would otherwise look like paths. Compared as a sorted multiset so
  // word-order changes around the URL still pass.
  const urlPattern = /(?:https?:\/\/[^\s<>"']+|\/[A-Za-z][A-Za-z0-9_\-./]*(?=[\s,.;:!?)\]]|$))/g;
  const enUrls = (en.match(urlPattern) || []).slice().sort();
  const tUrls = (translated.match(urlPattern) || []).slice().sort();
  if (enUrls.join('|') !== tUrls.join('|')) return false;

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
  const pluralBases = findPluralBases(enFlat);
  console.log(`[translate] EN source: ${enPath} (${Object.keys(enFlat).length} keys, ${pluralBases.size} pluralized bases)`);

  const targets = onlyLocales || LOCALES;
  let totalMissing = 0;
  let totalTranslated = 0;
  let totalRejected = 0;

  for (const loc of targets) {
    const locPath = path.join(ROOT, `${loc}.json`);
    // Skip locales that don't exist in the active root. The unified LOCALES
    // list serves both the main app (src/locales/) and the pro-test bundle
    // (pro-test/src/locales/), but the two roots are independent — a locale
    // added to main may not yet have a pro-test counterpart. Skip silently
    // so --pro-test and default modes both work without a placeholder file
    // (placeholders trigger the pro-bundle freshness hook because they
    // change the lazy-loaded chunk graph).
    if (!existsSync(locPath)) {
      console.log(`[${loc}] (no file at ${locPath}; skipping)`);
      continue;
    }
    const raw = JSON.parse(readFileSync(locPath, 'utf8'));
    const flat = flatten(raw);
    const categories = getPluralCategories(loc);
    const expected = expectedKeysForLocale(enFlat, pluralBases, categories);
    const missing = Object.keys(expected).filter(k => !(k in flat));
    if (missing.length === 0) {
      console.log(`[${loc}] ✓ already complete (CLDR categories: ${categories.join('/')})`);
      continue;
    }
    console.log(`[${loc}] missing ${missing.length} keys (${LANG_NAMES[loc]}, CLDR: ${categories.join('/')})`);
    totalMissing += missing.length;
    if (dryRun) continue;

    let added = 0;
    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
      const batch = missing.slice(i, i + BATCH_SIZE).map(k => [k, expected[k]]);
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
      const expected = expectedKeysForLocale(enFlat, pluralBases, getPluralCategories(loc));
      const left = Object.keys(expected).filter(k => !(k in flat));
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
