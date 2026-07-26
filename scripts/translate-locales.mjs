#!/usr/bin/env node
/**
 * Backfill missing locale strings using Claude Haiku as the translator.
 *
 * - Source of truth: src/locales/en.json (or pro-test/src/locales/en.json with --pro-test)
 * - Diffs each non-English locale against EN, sends the missing AND the stale
 *   keys in batches to Claude, deep-merges the response back into the locale file.
 * - Staleness is tracked by an EN baseline snapshot (scripts/locale-baselines/).
 *   A key that is present in a locale but whose English source has changed since
 *   the last completed run is retranslated. Without this, changing English copy
 *   silently rots every translation of it — and inserting one array element
 *   shifts every later index onto the wrong string (issue #5633).
 * - Preserves i18next interpolation tokens (`{{name}}`, `<strong>`, emoji,
 *   numerals, URLs) verbatim — the model is instructed not to translate them.
 * - Idempotent: re-running on a fully-translated, fully-fresh locale is a no-op.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/translate-locales.mjs
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/translate-locales.mjs --only=fr,de
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/translate-locales.mjs --pro-test
 *   node scripts/translate-locales.mjs --dry-run    # just report the gap
 *
 * Cost: ~8.3K strings × 20 locales backfill ≈ ~$3 on claude-haiku-4-5.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Anthropic } from '@anthropic-ai/sdk';

export const LOCALES = ['ar', 'bg', 'cs', 'de', 'el', 'es', 'fa', 'fr', 'hi', 'hr', 'hu', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'ro', 'ru', 'sv', 'th', 'tr', 'vi', 'zh'];
const LANG_NAMES = {
  ar: 'Arabic', bg: 'Bulgarian', cs: 'Czech', de: 'German', el: 'Greek',
  es: 'Spanish', fa: 'Persian (Farsi)', fr: 'French', hi: 'Hindi', hr: 'Croatian', hu: 'Hungarian', it: 'Italian', ja: 'Japanese',
  ko: 'Korean', nl: 'Dutch', pl: 'Polish', pt: 'Portuguese (Brazil)',
  ro: 'Romanian', ru: 'Russian', sv: 'Swedish', th: 'Thai', tr: 'Turkish',
  vi: 'Vietnamese', zh: 'Simplified Chinese',
};
const BATCH_SIZE = 50;
const MODEL = 'claude-haiku-4-5-20251001';

export function localesRootFor(proTest) {
  return proTest ? 'pro-test/src/locales' : 'src/locales';
}

// The baseline records the English string each committed translation was
// produced from. It cannot live beside the locale files: pro-test's i18n
// lazy-loads `./locales/*.json` via import.meta.glob, and the pro locale
// registry test asserts that directory holds exactly one file per language.
export function baselinePathFor(proTest) {
  return `scripts/locale-baselines/${proTest ? 'pro-test' : 'app'}.json`;
}

export function flatten(obj, prefix = '', out = {}) {
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
  // A batch of 50 long strings (the welcome FAQ answers run 300+ chars each) can
  // exceed max_tokens, and the reply is then cut mid-stream: the tail keys are
  // simply absent from the tab-separated output and look indistinguishable from
  // "the model chose to skip them". Say so, because it is a common reason a run
  // reports a shortfall. The re-run fills them — it only resends what is still
  // outstanding, so the retry batch is small enough not to truncate again.
  if (res.stop_reason === 'max_tokens') {
    console.warn('  ! reply hit max_tokens and was truncated — the tail of this batch was dropped');
  }
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
export function getPluralCategories(loc) {
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
export function findPluralBases(enFlat) {
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

export function expectedKeysForLocale(enFlat, pluralBases, categories) {
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

// Split a locale's expected keys into what has to be sent to the translator and
// what can be left alone.
//
//   missing   — no value in the locale at all
//   stale     — a value exists, but the English it was translated from has since
//               changed; the translation is silently wrong until it is redone
//   untracked — a value exists and the baseline has no record of its English
//               source. Left alone: adopting the baseline on an already
//               translated locale must not force a full retranslation. These
//               become tracked the first time the baseline advances.
//   fresh     — a value exists and its English source is unchanged
export function classifyKeys(localeFlat, expected, baselineExpected) {
  const missing = [];
  const stale = [];
  const untracked = [];
  const fresh = [];
  for (const [key, en] of Object.entries(expected)) {
    if (!(key in localeFlat)) missing.push(key);
    else if (!(key in baselineExpected)) untracked.push(key);
    else if (baselineExpected[key] !== en) stale.push(key);
    else fresh.push(key);
  }
  return { missing, stale, untracked, fresh };
}

// What is still wrong after a run. Staleness is a property of (baseline, en.json)
// alone — it says nothing about the locale's current value — so a key stays
// "stale" for the rest of the run even after it has just been retranslated. The
// baseline is what retires it, and the baseline only advances once nothing is
// outstanding. Without discounting the keys this run actually refreshed, that is
// a deadlock: the scan can never reach zero, so the baseline can never advance,
// so the next run re-translates exactly the same keys forever.
export function unresolvedAfterRun({ missing, stale }, refreshedKeys) {
  return { missing, stale: stale.filter(key => !refreshedKeys.has(key)) };
}

export function readBaseline(baselinePath) {
  if (!existsSync(baselinePath)) return null;
  return JSON.parse(readFileSync(baselinePath, 'utf8'));
}

function writeBaseline(baselinePath, enFlat) {
  mkdirSync(path.dirname(baselinePath), { recursive: true });
  // Sorted so the committed diff shows only the strings that actually moved.
  const sorted = Object.fromEntries(Object.keys(enFlat).sort().map(k => [k, enFlat[k]]));
  writeFileSync(baselinePath, JSON.stringify(sorted, null, 2) + '\n');
}

export function validateTranslation(en, translated) {
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
  //
  // The leading `(?<![A-Za-z0-9])` is what separates a path from a slash used as
  // punctuation between two words. Without it, `calls/day`, `requests/minute`
  // and `$69.99/mo` all register `/day`, `/minute`, `/mo` as paths, and every
  // translation that renders the rate naturally ("250 Aufrufe pro Tag") is
  // rejected for "dropping a URL". That rejection is deterministic, so those
  // keys could never converge no matter how often the run was repeated — they
  // stayed as array holes that serialise to `null`. A genuine path is preceded
  // by start-of-string, whitespace or an opening bracket.
  const urlPattern = /(?:https?:\/\/[^\s<>"']+|(?<![A-Za-z0-9])\/[A-Za-z][A-Za-z0-9_\-./]*(?=[\s,.;:!?)\]]|$))/g;
  const enUrls = (en.match(urlPattern) || []).slice().sort();
  const tUrls = (translated.match(urlPattern) || []).slice().sort();
  if (enUrls.join('|') !== tUrls.join('|')) return false;

  return true;
}

async function main() {
  // argv is parsed here rather than at module scope so importing this file for
  // its pure helpers (tests, the locale freshness gate) has no side effects and
  // does not inherit the test runner's arguments.
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');
  const proTest = args.has('--pro-test');
  const onlyArg = [...args].find(a => a.startsWith('--only='));
  const onlyLocales = onlyArg ? onlyArg.slice('--only='.length).split(',') : null;
  const ROOT = localesRootFor(proTest);

  if (!dryRun && !process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set. Use --dry-run to see the gap without translating.');
    process.exit(1);
  }
  const client = dryRun ? null : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const enPath = path.join(ROOT, 'en.json');
  const enFlat = flatten(JSON.parse(readFileSync(enPath, 'utf8')));
  const pluralBases = findPluralBases(enFlat);
  console.log(`[translate] EN source: ${enPath} (${Object.keys(enFlat).length} keys, ${pluralBases.size} pluralized bases)`);

  const baselinePath = baselinePathFor(proTest);
  const baselineFlat = readBaseline(baselinePath);
  const baselinePlurals = baselineFlat ? findPluralBases(baselineFlat) : new Map();
  if (baselineFlat) {
    console.log(`[translate] EN baseline: ${baselinePath} (${Object.keys(baselineFlat).length} keys)`);
  } else {
    console.log(`[translate] EN baseline: none at ${baselinePath} — every existing translation is treated as untracked (nothing is retranslated); the baseline is written once every locale is complete.`);
  }
  const baselineFor = (categories) =>
    baselineFlat ? expectedKeysForLocale(baselineFlat, baselinePlurals, categories) : {};

  const targets = onlyLocales || LOCALES;
  // locale → keys this run successfully wrote. Consumed by unresolvedAfterRun.
  const refreshedByLocale = new Map();
  let totalMissing = 0;
  let totalStale = 0;
  let totalUntracked = 0;
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
    const { missing, stale, untracked } = classifyKeys(flat, expected, baselineFor(categories));
    totalUntracked += untracked.length;
    // Stale keys are sent alongside missing ones; setNested overwrites the
    // rotted value in place.
    const toTranslate = [...missing, ...stale];
    if (toTranslate.length === 0) {
      console.log(`[${loc}] ✓ complete and fresh (CLDR categories: ${categories.join('/')})`);
      continue;
    }
    console.log(`[${loc}] ${missing.length} missing + ${stale.length} stale keys (${LANG_NAMES[loc]}, CLDR: ${categories.join('/')})`);
    if (stale.length > 0) {
      console.log(`[${loc}]   stale e.g. ${stale.slice(0, 3).join(', ')}`);
    }
    totalMissing += missing.length;
    totalStale += stale.length;
    if (dryRun) continue;

    const refreshed = new Set();
    refreshedByLocale.set(loc, refreshed);
    let added = 0;
    for (let i = 0; i < toTranslate.length; i += BATCH_SIZE) {
      const batch = toTranslate.slice(i, i + BATCH_SIZE).map(k => [k, expected[k]]);
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
          refreshed.add(k);
          added++;
        }
      } catch (err) {
        console.error(`[${loc}] batch ${i}-${i + batch.length} failed:`, err.message);
      }
      writeFileSync(locPath, JSON.stringify(raw, null, 2) + '\n');
      console.log(`[${loc}] progress ${Math.min(i + BATCH_SIZE, toTranslate.length)}/${toTranslate.length}`);
    }
    totalTranslated += added;
    // A shortfall means the model omitted keys from its reply or validateTranslation
    // rejected them. Say so here rather than leaving it to the post-run scan —
    // the fix is simply to run again, and the run is idempotent.
    const shortfall = toTranslate.length - added;
    console.log(
      shortfall > 0
        ? `[${loc}] ✓ wrote ${added} translations (${shortfall} not returned or rejected — re-run to fill)`
        : `[${loc}] ✓ wrote ${added} translations`,
    );
  }

  // Re-scan post-write to confirm full coverage. A partial run (rejections,
  // batch failures, model omissions) must surface as a non-zero exit so CI
  // and operators don't trust a half-finished locale set.
  //
  // The scan covers EVERY locale, not just this run's targets, because the
  // baseline is a claim about the whole root ("every committed translation was
  // produced from this English snapshot"). Advancing it after an --only run
  // would mark the locales that were skipped as fresh and hide their rot
  // permanently.
  let unresolved = 0;
  if (!dryRun) {
    for (const loc of LOCALES) {
      const locPath = path.join(ROOT, `${loc}.json`);
      if (!existsSync(locPath)) continue;
      const flat = flatten(JSON.parse(readFileSync(locPath, 'utf8')));
      const categories = getPluralCategories(loc);
      const expected = expectedKeysForLocale(enFlat, pluralBases, categories);
      const left = unresolvedAfterRun(
        classifyKeys(flat, expected, baselineFor(categories)),
        refreshedByLocale.get(loc) ?? new Set(),
      );
      const outstanding = left.missing.length + left.stale.length;
      if (outstanding > 0) {
        const sample = [...left.missing, ...left.stale].slice(0, 3).join(', ');
        console.error(`[${loc}] ✗ still ${left.missing.length} missing / ${left.stale.length} stale after run (e.g. ${sample})`);
        unresolved += outstanding;
      }
    }
  }

  console.log(`\n[done] missing ${totalMissing}, stale ${totalStale}, untracked ${totalUntracked}, translated ${totalTranslated}, rejected ${totalRejected}, unresolved-after-run ${unresolved}`);
  if (totalRejected > 0 || unresolved > 0) {
    console.error('\n[FAIL] Partial backfill — re-run translate-locales.mjs to fill remaining keys.');
    process.exit(1);
  }

  if (!dryRun) {
    writeBaseline(baselinePath, enFlat);
    console.log(`[translate] baseline advanced: ${baselinePath} now records the English every locale was translated from.`);
  }
}

// realpath BOTH sides: through a symlinked checkout Node sets import.meta.url
// to the realpath while argv[1] keeps the symlink, and the naive comparison
// silently skips main().
const isMain =
  process.argv[1] &&
  pathToFileURL(realpathSync(process.argv[1])).href ===
    pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;

if (isMain) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
