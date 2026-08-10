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
 *   ... --adopt-baseline   # FIRST adoption of a root only; records the current
 *                          # translations as correct without checking them
 *
 * Cost: ~8.3K strings × 20 locales backfill ≈ ~$3 on claude-haiku-4-5.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Anthropic } from '@anthropic-ai/sdk';

export const LOCALES = ['ar', 'bg', 'cs', 'de', 'el', 'es', 'fa', 'fr', 'hi', 'hr', 'hu', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'ro', 'ru', 'sv', 'th', 'tr', 'uk', 'vi', 'zh'];
const LANG_NAMES = {
  ar: 'Arabic', bg: 'Bulgarian', cs: 'Czech', de: 'German', el: 'Greek',
  es: 'Spanish', fa: 'Persian (Farsi)', fr: 'French', hi: 'Hindi', hr: 'Croatian', hu: 'Hungarian', it: 'Italian', ja: 'Japanese',
  ko: 'Korean', nl: 'Dutch', pl: 'Polish', pt: 'Portuguese (Brazil)',
  ro: 'Romanian', ru: 'Russian', sv: 'Swedish', th: 'Thai', tr: 'Turkish',
  uk: 'Ukrainian', vi: 'Vietnamese', zh: 'Simplified Chinese',
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

// A UI string arrives at the translator as a bare label with no surrounding screen, so
// every domain term that is also an everyday word gets read in its everyday sense. That is
// not a hypothetical: the German locale shipped "mil. vessels" as "Mil. Gefäße" (blood
// vessels), "active strikes" as "aktive Streiks" (labour strikes), "matches" as
// "Streichhölzer" (matchsticks) and "TRACKED VESSELS" as "RAUPENSCHIFFE" (caterpillar-
// tracked ships). Naming the intended sense once, for every locale, is what stops it —
// the alternative is 25 locales each rediscovering the same wrong reading.
const DOMAIN_GLOSSARY = [
  'strike = a military/air strike, never a labour strike',
  'vessel = a ship',
  'tracked = monitored/followed, never caterpillar tracks',
  'intelligence = reconnaissance and intelligence reporting (OSINT), never IQ or cleverness',
  'brief / briefing = a short situation report, never a letter or a legal filing',
  'coverage (of stories, sources, news) = press/news reporting, not technical signal coverage',
  'watch (DPRK Watch, Central Bank Watch, WATCH level) = monitoring, never a timepiece',
  'theater / theatre = a military theatre of operations, never a playhouse',
  'fighter = a fighter aircraft, never a person who fights',
  'carrier = an airline in aviation contexts, an aircraft carrier in naval ones, never a courier',
  'shipping = maritime transport and freight, never parcel delivery',
  'host (displacement data) = a country hosting refugees, never a party host',
  'match = a search hit, never a matchstick or a sports fixture',
  'accelerator = a startup accelerator, never a particle accelerator or a pedal',
  'irradiator = an industrial gamma irradiation facility',
  'power (power plant, TOTAL POWER) = electrical power/output, never political might',
  'asset (related assets) = a piece of infrastructure, not only a financial asset',
  'flow (ETF flows, net flow) = capital moving in or out, not a fluid current',
  'close (market close, Closes) = the closing price or closing date, not the verb "to close"',
  'movers = the biggest gainers and losers, not people or vehicles that move',
  'designation (sanctions) = adding an entity to a sanctions list',
  'story = a news item, not a work of fiction',
  'cancelled (flight) = the airline annulled the flight, not a customer cancelling an order',
  'staged (settings) = queued, awaiting save, never theatrical staging',
  'dismiss (a banner, alert, finding) = hide it, never reject or repudiate it',
  'default = the standard preset value, not a financial default',
  'spot, spread, long, short, hedge, perp, open interest, drawdown = finance terms; keep the established term of the target language, which is often the English one',
].map((line) => `   - ${line}`).join('\n');

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
9. This is an OSINT / geopolitics / markets dashboard. The strings are labels torn out of that context, so the everyday reading of a word is usually the wrong one. Translate these terms in the sense given here:
${DOMAIN_GLOSSARY}
10. Product, brand and dataset names stay untranslated: Product Hunt, Techmeme, Big Mac Index, Smartraveller, GDELT, Polymarket, Hyperliquid, OpenSky, Cloudflare Radar, World Monitor. The same holds for the app's own component names a translation cannot rename: sidecar, widget, panel, dashboard, feed.

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
//               source. ONLY a valid class while the baseline is being created:
//               adopting it on an already translated locale must not force a
//               full retranslation. Once a baseline exists, a key missing from
//               it is unprovenanced, not fresh, and is treated as stale — see
//               below.
//   orphan    — the locale has a value the current English does not, i.e. the
//               locale is not a subset of EN. Removing the LAST element of an
//               English array leaves exactly this: every later index still
//               matches, so nothing is stale, and 24 languages keep advertising
//               a bullet the tier no longer offers. It is #5633 arriving from
//               the opposite direction, and retranslation cannot fix it — the
//               value has to be pruned.
//   fresh     — a value exists and its English source is unchanged
//
// `baselineExists` is what separates adoption from rot. With no baseline, an
// unprovenanced key is simply untracked history and must be left alone. With a
// baseline, the same key means the recorded English was lost — by a partial run
// that wrote locale files but never advanced the baseline, by a merge conflict
// resolved in the generated file, or by someone deleting it — and calling that
// "fresh" is precisely how rot becomes permanent: the run exits 0, the baseline
// advances, and the wrong translation is certified against English it was never
// shown.
export function classifyKeys(localeFlat, expected, baselineExpected, baselineExists = false) {
  const missing = [];
  const stale = [];
  const untracked = [];
  const fresh = [];
  for (const [key, en] of Object.entries(expected)) {
    if (!(key in localeFlat)) missing.push(key);
    else if (!(key in baselineExpected)) (baselineExists ? stale : untracked).push(key);
    else if (baselineExpected[key] !== en) stale.push(key);
    else fresh.push(key);
  }
  const orphan = Object.keys(localeFlat).filter(key => !(key in expected) && !isPrivateKey(key));
  return { missing, stale, untracked, orphan, fresh };
}

// What is still wrong after a run. Staleness is a property of (baseline, en.json)
// alone — it says nothing about the locale's current value — so a key stays
// "stale" for the rest of the run even after it has just been retranslated. The
// baseline is what retires it, and the baseline only advances once nothing is
// outstanding. Without discounting the keys this run actually refreshed, that is
// a deadlock: the scan can never reach zero, so the baseline can never advance,
// so the next run re-translates exactly the same keys forever.
export function unresolvedAfterRun({ missing, stale, orphan = [] }, refreshedKeys) {
  // Orphans are never "refreshed" — no amount of translating fixes a value the
  // English no longer has — so they pass through untouched.
  return { missing, stale: stale.filter(key => !refreshedKeys.has(key)), orphan };
}

// May this run overwrite the baseline? Advancing it is the single irreversible
// act in the script: it declares "every committed translation was produced from
// this English", and once a wrong translation is recorded that way, nothing ever
// looks at it again. So the predicate is deliberately paranoid, and it is a pure
// function rather than an inline condition so the truth table can be tested.
export function mayAdvanceBaseline({
  unresolved,
  rejected,
  untracked,
  baselineExisted,
  adoptBaseline = false,
  dryRun,
}) {
  if (dryRun) return { advance: false, reason: 'dry run' };
  if (unresolved > 0) return { advance: false, reason: `${unresolved} key(s) still missing, stale or orphaned` };
  if (rejected > 0) return { advance: false, reason: `${rejected} translation(s) rejected` };
  // Untracked keys mean the run is about to declare translations correct against
  // English it never checked them against. That is legitimate exactly once per
  // root — the initial adoption — and is a disaster every other time, so it has
  // to be asked for rather than inferred.
  //
  // Both shapes matter, and they are NOT the same check. A baseline that exists
  // but lost entries (a merge conflict resolved inside the generated file) is
  // caught by baselineExisted. A DELETED baseline looks identical to a first
  // run, so it needs the explicit flag: without it, `rm` on the baseline plus a
  // re-run silently re-adopts every current translation — including rotted ones
  // — as correct, with no API call and exit 0.
  if (untracked > 0 && !adoptBaseline) {
    return {
      advance: false,
      reason: baselineExisted
        ? `${untracked} key(s) have no recorded English despite an existing baseline — it lost entries; restore it from git rather than letting this run re-adopt the current translations`
        : `no baseline found, so ${untracked} existing translation(s) would be adopted as correct without ever being checked — restore the baseline from git, or pass --adopt-baseline if this root is genuinely adopting one for the first time`,
    };
  }
  return { advance: true, reason: 'every locale complete and fresh' };
}

// Delete the values the current English has no key for.
//
// This is the one class retranslation cannot fix — no translation of a source
// string that no longer exists can be correct — so without pruning, detection
// alone leaves the pass permanently blocked behind manual JSON editing, and
// removing a single English array element orphans every locale at once.
//
// Deletion is safe by construction: i18next resolves against the English key
// set, so a key absent from it is already unreachable at runtime.
export function pruneOrphans(raw, orphanKeys) {
  // Arrays are truncated rather than spliced element-by-element. Orphaned
  // indices are always a tail — every index the English defines is, by
  // definition, not an orphan — so cutting at the lowest orphaned index removes
  // exactly the surplus, and cannot shift a surviving element the way repeated
  // deletion would.
  const truncateAt = new Map();
  const plainKeys = [];
  for (const key of orphanKeys) {
    const match = key.match(/^(.*)\[(\d+)\]$/);
    if (!match) {
      plainKeys.push(key);
      continue;
    }
    const [, arrayPath, index] = match;
    const at = Number(index);
    truncateAt.set(arrayPath, Math.min(truncateAt.get(arrayPath) ?? at, at));
  }

  for (const [arrayPath, index] of truncateAt) {
    const target = resolveNested(raw, arrayPath);
    if (Array.isArray(target) && target.length > index) target.length = index;
  }
  for (const key of plainKeys) {
    const lastDot = key.lastIndexOf('.');
    const parent = lastDot === -1 ? raw : resolveNested(raw, key.slice(0, lastDot));
    const leaf = lastDot === -1 ? key : key.slice(lastDot + 1);
    if (parent && typeof parent === 'object') delete parent[leaf];
  }
}

// Walk a flattened key path to the value it names, or undefined if any step is
// absent — a locale may not have the shape the key implies.
function resolveNested(obj, dotted) {
  let cur = obj;
  for (const part of dotted.split('.')) {
    const match = part.match(/^([^[]*)((?:\[\d+\])+)?$/);
    if (!match) return undefined;
    if (match[1]) {
      if (cur === null || typeof cur !== 'object') return undefined;
      cur = cur[match[1]];
    }
    if (match[2]) {
      for (const idx of match[2].matchAll(/\[(\d+)\]/g)) {
        if (!Array.isArray(cur)) return undefined;
        cur = cur[Number(idx[1])];
      }
    }
  }
  return cur;
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

// The three shapes a translation must preserve verbatim, as a sorted multiset.
//
// The middle arm is deliberately loose in the regex and strict in the filter.
// Expressing "dotted host with a real TLD" directly as `[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}`
// nests a quantifier over an overlapping class, so when the TLD never matches
// the engine re-partitions every dot boundary — 8k dots took 6.3 seconds, and
// this runs on unbounded model output. Matching up to the slash with a class
// that excludes `/` is deterministic, and the host test is then a plain string
// check that cannot backtrack at all.
export function extractUrlTokens(text) {
  // Every arm needs a slash, so text without one cannot contain a match and the
  // scan is skipped entirely.
  if (!text.includes('/')) return [];

  // Two devices keep this linear on unbounded model output:
  //
  //   `(?=(X))\N` is the JS spelling of an atomic group — the lookahead matches
  //   X greedily once and the backreference consumes exactly that, so the engine
  //   cannot re-try shorter prefixes. Host and first-path-segment are each
  //   followed by a required `/` their own class can never match, making every
  //   such retry guaranteed to fail.
  //
  //   The upper bounds stop each start position scanning the whole string. They
  //   are the real limits, not arbitrary caps: RFC 1035 caps a hostname at 253
  //   characters, and a 128-character first path segment is far past anything
  //   this catalog links to. Unbounded, both are O(n^2) by position even when
  //   atomic — 16k characters took ~11s.
  const pattern =
    /(?:https?:\/\/[^\s<>"']+|[A-Za-z0-9](?=([A-Za-z0-9.-]{0,253}))\1\/[A-Za-z0-9_\-./]*[A-Za-z0-9_\-/]|(?<![A-Za-z0-9])\/[A-Za-z](?=([A-Za-z0-9_\-.]{0,128}))\2\/[A-Za-z0-9_\-./]*(?=[\s,.;:!?)\]]|$))/g;
  return (text.match(pattern) || [])
    .filter((token) => {
      if (/^https?:\/\//.test(token)) return true;
      // A bare absolute path — already constrained to two segments by the arm
      // that produced it.
      if (token.startsWith('/')) return true;
      // Host-qualified: keep it only if what precedes the first slash really
      // looks like a hostname. This is what separates `worldmonitor.app/docs`
      // from `calls/day` (no dot) and `1.5/kg` (last label is not a TLD).
      const host = token.slice(0, token.indexOf('/'));
      const labels = host.split('.');
      return labels.length > 1 && /^[A-Za-z]{2,}$/.test(labels[labels.length - 1]);
    })
    .sort();
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
  // Two constraints separate a real path from a slash used as punctuation, and
  // both are needed — the failure shows up from each side:
  //
  //   `(?<![A-Za-z0-9])`  the slash must not follow a letter or digit, so
  //                       `calls/day` and `requests/minute` are not paths. Without
  //                       it every translation rendering the rate naturally
  //                       ("250 Aufrufe pro Tag") was rejected for DROPPING a URL.
  //   a second segment    the path must contain a further `/`, so `/Monat` and
  //                       `/mois` are not paths. Without it German and French
  //                       prices ("69,99 $/Monat" — slash after a space) were
  //                       rejected for INVENTING one.
  //
  // Both rejections are deterministic, so the affected keys could never converge
  // however often the pass was repeated; they stayed as array holes serialising
  // to `null`. The two-segment rule is safe here because every genuine bare path
  // in both EN catalogs is multi-segment (`/docs/methodology/...`); the only
  // single-segment matches are the price suffixes `/mo` and `/yr`, which must be
  // translated, not preserved.
  //
  const enUrls = extractUrlTokens(en);
  const tUrls = extractUrlTokens(translated);
  if (enUrls.join('|') !== tUrls.join('|')) return false;

  return true;
}

// Send one locale's outstanding keys through the translator and write the
// accepted results back.
//
// `translate` and `persist` are injected so this is testable without a network
// client or a filesystem: it is the half of the fix that classification does not
// cover, and a reversed concat or a dropped `refreshed.add` here would recreate
// #5633 while every classification test stayed green.
//
// Returns the keys actually written — not the ones attempted. That distinction
// is what the baseline-advance gate depends on: a key the model omitted or the
// validator rejected must stay outstanding.
export async function translateLocale({ loc, raw, expected, toTranslate, translate, persist, batchSize = BATCH_SIZE }) {
  const refreshed = new Set();
  let added = 0;
  let rejected = 0;

  for (let i = 0; i < toTranslate.length; i += batchSize) {
    const batch = toTranslate.slice(i, i + batchSize).map(k => [k, expected[k]]);
    try {
      const translations = await translate(batch);
      for (const [k, en] of batch) {
        const tr = translations[k];
        if (!tr) continue;
        if (!validateTranslation(en, tr)) {
          rejected++;
          continue;
        }
        setNested(raw, k, tr);
        refreshed.add(k);
        added++;
      }
    } catch (err) {
      // A failed batch leaves its keys unrefreshed, so the post-run scan still
      // sees them and the run exits non-zero. Failing the whole locale here
      // would throw away the batches that did succeed.
      console.error(`[${loc}] batch ${i}-${i + batch.length} failed:`, err.message);
    }
    // Persist after every batch so an interrupted run keeps its progress.
    persist();
    console.log(`[${loc}] progress ${Math.min(i + batchSize, toTranslate.length)}/${toTranslate.length}`);
  }

  return { refreshed, added, rejected };
}

async function main() {
  // argv is parsed here rather than at module scope so importing this file for
  // its pure helpers (tests, the locale freshness gate) has no side effects and
  // does not inherit the test runner's arguments.
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');
  const proTest = args.has('--pro-test');
  const adoptBaseline = args.has('--adopt-baseline');
  const onlyArg = [...args].find(a => a.startsWith('--only='));
  const onlyLocales = onlyArg ? onlyArg.slice('--only='.length).split(',') : null;
  const ROOT = localesRootFor(proTest);

  // An unknown locale in --only would otherwise be skipped with a note and the
  // run would still report success, so `--only=de,ff` silently does half the
  // work it was asked for.
  if (onlyLocales) {
    const unknown = onlyLocales.filter(loc => !LOCALES.includes(loc));
    if (unknown.length > 0) {
      console.error(`--only names ${unknown.length} unknown locale(s): ${unknown.join(', ')}. Known: ${LOCALES.join(', ')}`);
      process.exit(1);
    }
  }

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
  let totalOrphan = 0;
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
    const { missing, stale, untracked, orphan } = classifyKeys(
      flat,
      expected,
      baselineFor(categories),
      baselineFlat !== null,
    );
    totalUntracked += untracked.length;
    totalOrphan += orphan.length;
    if (orphan.length > 0) {
      const sample = orphan.slice(0, 3).join(', ');
      if (dryRun) {
        console.warn(`[${loc}]   ${orphan.length} orphaned key(s) the English no longer has (e.g. ${sample})`);
      } else {
        pruneOrphans(raw, orphan);
        writeFileSync(locPath, `${JSON.stringify(raw, null, 2)}\n`);
        console.log(`[${loc}]   pruned ${orphan.length} orphaned key(s) the English no longer has (e.g. ${sample})`);
      }
    }
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

    const { refreshed, added, rejected } = await translateLocale({
      loc,
      raw,
      expected,
      toTranslate,
      translate: batch => translateBatch(client, LANG_NAMES[loc], batch),
      persist: () => writeFileSync(locPath, `${JSON.stringify(raw, null, 2)}\n`),
    });
    refreshedByLocale.set(loc, refreshed);
    totalTranslated += added;
    totalRejected += rejected;
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
        classifyKeys(flat, expected, baselineFor(categories), baselineFlat !== null),
        refreshedByLocale.get(loc) ?? new Set(),
      );
      const outstanding = left.missing.length + left.stale.length + left.orphan.length;
      if (outstanding > 0) {
        const sample = [...left.missing, ...left.stale, ...left.orphan].slice(0, 3).join(', ');
        console.error(`[${loc}] ✗ still ${left.missing.length} missing / ${left.stale.length} stale / ${left.orphan.length} orphaned after run (e.g. ${sample})`);
        unresolved += outstanding;
      }
    }
  }

  // The post-run scan is the only thing that sets `unresolved`, and it does not
  // run in dry-run — printing 0 there reads as an all-clear next to a non-zero
  // orphan or stale count.
  const unresolvedReport = dryRun ? 'n/a (dry run)' : unresolved;
  console.log(`\n[done] missing ${totalMissing}, stale ${totalStale}, untracked ${totalUntracked}, orphaned ${totalOrphan}, translated ${totalTranslated}, rejected ${totalRejected}, unresolved-after-run ${unresolvedReport}`);

  const verdict = mayAdvanceBaseline({
    unresolved,
    rejected: totalRejected,
    untracked: totalUntracked,
    baselineExisted: baselineFlat !== null,
    adoptBaseline,
    dryRun,
  });
  if (!dryRun && !verdict.advance) {
    console.error(`\n[FAIL] baseline not advanced — ${verdict.reason}.`);
    process.exit(1);
  }
  if (verdict.advance) {
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
