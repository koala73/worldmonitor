#!/usr/bin/env node

/**
 * Seed: Think Global Health Vaccine-Preventable Disease Tracker
 *
 * Source: https://thinkglobalhealth.github.io/disease_tracker
 * Both datasets are embedded in index_bundle.js (updated ~weekly by CFR staff).
 * No API key required — the bundle is public GitHub Pages.
 *
 * Writes two Redis keys:
 *   health:vpd-tracker:realtime:v1   — geo-located outbreak alerts (lat/lng, cases, source URL)
 *   health:vpd-tracker:historical:v1 — WHO annual case counts by country/disease/year
 */

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'health:vpd-tracker:realtime:v1';
const HISTORICAL_KEY = 'health:vpd-tracker:historical:v1';
const BUNDLE_URL = 'https://thinkglobalhealth.github.io/disease_tracker/index_bundle.js';
const CACHE_TTL = 259200; // 72h (3 days) — 3× daily cron interval per gold standard; survives 2 consecutive missed runs

/**
 * Extract a JSON array from an `eval("var res = [...]")` block in the bundle.
 *
 * Bundle format (post-2026-04 webpack rebuild — verified against the live
 * 7.5MB index_bundle.js on 2026-05-01):
 *
 *   eval("var res = [{\"Alert_ID\":\"8731706\",\"lat\":\"56.85\",...}, ...]")
 *   eval("var res = [{\"country\":\"Afghanistan\",\"iso\":\"AF\",...}, ...]")
 *
 * The bundle has exactly TWO such blocks: one whose first object key is
 * `Alert_ID` (realtime alerts), one whose first key is `country` (historical
 * WHO annual counts). The wrapping is a JS string literal — properties are
 * JSON-quoted with backslash-escaped quotes.
 *
 * Pre-2026-04 the bundle used `var a=[{Alert_ID:"...",...}]` (unquoted keys,
 * named array, separate `.columns` metadata) and the parser anchored on
 * `.columns=["Alert_ID"`, `var a=[`, and `[{country:"`. All three anchors
 * are dead in the current bundle. This rewrite anchors on the FIELD NAMES
 * (`Alert_ID`, `country`) which are domain-stable — they only change if
 * Think Global Health renames the data schema itself, not when their
 * bundler is upgraded.
 *
 * @param {string} bundle  raw JS bundle text
 * @param {string} marker  first field name of the target dataset (e.g. 'Alert_ID', 'country')
 * @returns {Array<object>} parsed JSON array
 */
/**
 * Walk the JS-escaped form of one `eval("var res = [...]")` array starting
 * at `arrayOpen` (the `[` byte) and find the matching closing `]`. Returns
 * the index of that `]` in the bundle, or -1 on truncation.
 *
 * The scanner operates at TWO levels of escaping simultaneously:
 *
 *   Level 1 (bundle text → eval'd source):
 *     The bundle wraps the eval'd JSON in a JS string literal. Each `\X`
 *     in the bundle (where X is `"`, `\`, `n`, `t`, `r`, `b`, `f`, `/`,
 *     `'`, or `uXXXX`) decodes to ONE character in the eval'd source.
 *
 *   Level 2 (eval'd source → JSON):
 *     The eval'd source is JSON. Inside a JSON string, an eval'd `\"` is
 *     the JSON escape for a literal `"` and must NOT toggle the string
 *     boundary. Outside a JSON string, an eval'd `[`/`]` shifts depth.
 *
 * Earlier versions conflated the two levels: a bundle sequence like
 * `\\\"` (representing eval'd `\"` — JSON-escaped quote inside a string
 * value) was incorrectly read as `\\` + `\"`, where the trailing `\"`
 * toggled inJsonString mid-value. Free-text fields like `summary` can
 * contain `"quoted phrases"` with brackets, e.g. `Officials confirm
 * "[regional] outbreak" contained` — that would produce `\\\"...]\\\"...`
 * sequences that misaligned bracket counting.
 *
 * The corrected algorithm: decode each bundle byte to its eval'd
 * character first, then run a JSON-aware state machine over the
 * decoded stream.
 */
function findArrayCloseInEscapedForm(bundle, arrayOpen) {
  // Map of single-char JS-string escape sequences. `\u` is handled
  // separately because it consumes 4 additional hex digits.
  const SINGLE_ESCAPE = { '"': '"', '\\': '\\', '/': '/', 'n': '\n', 't': '\t', 'r': '\r', 'b': '\b', 'f': '\f', "'": "'" };

  let depth = 0;
  let inJsonString = false;
  let inJsonEscape = false; // inside JSON string AND just saw a `\` in eval'd source
  let i = arrayOpen;

  while (i < bundle.length) {
    // ---- Level 1: decode one eval'd char from bundle ----
    let evaledCh;
    let advance;
    if (bundle[i] === '\\') {
      const next = bundle[i + 1];
      if (next === undefined) return -1; // truncated trailing backslash
      if (next === 'u') {
        const hex = bundle.slice(i + 2, i + 6);
        if (hex.length < 4) return -1;
        evaledCh = String.fromCharCode(parseInt(hex, 16));
        advance = 6;
      } else {
        evaledCh = SINGLE_ESCAPE[next] ?? next;
        advance = 2;
      }
    } else {
      evaledCh = bundle[i];
      advance = 1;
    }

    // ---- Level 2: JSON state machine over eval'd char ----
    if (inJsonString) {
      if (inJsonEscape) {
        // Previous eval'd char was `\` (JSON escape). This char is the
        // escape target; consume without changing string/bracket state.
        // (JSON's \uXXXX has 4 hex digits — those are not brackets and
        // not quotes, so we don't need to special-case them here for
        // correctness; depth/inJsonString are correctly preserved.)
        inJsonEscape = false;
      } else if (evaledCh === '\\') {
        inJsonEscape = true;
      } else if (evaledCh === '"') {
        inJsonString = false;
      }
      // else: ordinary char inside JSON string — skip
    } else {
      if (evaledCh === '"') {
        inJsonString = true;
      } else if (evaledCh === '[') {
        depth++;
      } else if (evaledCh === ']') {
        depth--;
        if (depth === 0) return i + advance - 1; // last byte of the closing `]`
      }
    }

    i += advance;
  }
  return -1;
}

/**
 * Enumerate every `eval("var res = [...JSON-array...]")` block in the bundle.
 * Yields `{ array }` for each one that parses cleanly; silently skips
 * truncated or malformed candidates.
 *
 * Used by parseRealtimeAlerts / parseHistoricalData to identify their
 * target dataset by SCHEMA (field-presence in any record), not by the
 * first-key position in the first record. A harmless upstream reordering
 * like `{"country":"X","iso":"Y"}` → `{"iso":"Y","country":"X"}` would
 * have broken a position-anchored parser; this approach treats either
 * order as the same dataset.
 */
function* iterateEvalResArrays(bundle) {
  let pos = 0;
  const blockNeedle = 'eval("var res = [';
  while (true) {
    const start = bundle.indexOf(blockNeedle, pos);
    if (start === -1) return;
    const arrayOpen = start + 'eval("var res = '.length; // points at `[`
    const arrayClose = findArrayCloseInEscapedForm(bundle, arrayOpen);
    if (arrayClose === -1) return; // truncated; nothing further is parseable
    const escaped = bundle.slice(arrayOpen, arrayClose + 1);
    try {
      const arrayJson = JSON.parse(`"${escaped}"`);
      const array = JSON.parse(arrayJson);
      if (Array.isArray(array)) yield { array };
    } catch {
      // Malformed candidate (rare — would mean we mis-counted brackets).
      // Skip and keep searching for the next eval block.
    }
    pos = arrayClose + 1;
  }
}

/**
 * Brace-walk a plain-JS array literal starting at `arrayOpen` (the `[` byte)
 * and return the index of the matching `]`, or -1 on truncation.
 *
 * This is a separate scanner from findArrayCloseInEscapedForm: that one
 * operates over JS-string-escaped JSON (the eval-wrapped format added in
 * the April 2026 webpack rewrite). This scanner operates over plain JS
 * source where strings use `"..."` with `\"` for embedded quotes and
 * brackets inside strings must NOT shift depth.
 *
 * Bundle 2026-05 reverted to this format (or shipped a third variant).
 * Verified against the 4MB index_bundle.js on 2026-05-09 — `var a=[{Alert_ID:"...",...},...]`
 * with unquoted keys and direct double-quoted values, no eval wrapper.
 */
function findArrayCloseInPlainJS(bundle, arrayOpen) {
  let depth = 0;
  let stringQuote = null; // null | '"' | "'"
  let i = arrayOpen;
  while (i < bundle.length) {
    const ch = bundle[i];
    if (stringQuote !== null) {
      if (ch === '\\') {
        // Bundle-truncation guard: if `\` is the last byte, don't overshoot
        // EOF on the +2 advance — break and let the outer "no close found"
        // path return -1.
        if (i + 1 >= bundle.length) break;
        i += 2;
        continue;
      }
      if (ch === stringQuote) stringQuote = null;
    } else {
      if (ch === '"' || ch === "'") stringQuote = ch;
      else if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) return i;
      }
    }
    i++;
  }
  return -1;
}

/**
 * Convert a plain-JS array literal into pure JSON in a single pass:
 *   1. `'...'` string values   → `"..."` JSON strings (with proper re-escaping
 *      of any literal `"` that appeared inside the single-quoted body).
 *   2. Unquoted keys after `{` or `,` → `"key":`
 *
 * Both transforms in one walker so the key-quoting step CANNOT misfire on
 * `, identifier:` sequences embedded inside string values (e.g. a summary
 * field containing "Cases linked, date: 2026-05-01"). The walker tracks
 * `inString` and only inserts key quotes when out-of-string.
 *
 * Pre-PR-3636 these were two separate passes (a regex over the post-string-
 * normalized output). Codex review round 1 P2 flagged that the regex pass
 * had no string-state awareness and could corrupt summary fields that
 * happened to contain `,<word>:` sequences. This single-pass walker
 * eliminates the class of bug.
 */
function jsLiteralToJSON(literal) {
  let out = '';
  let i = 0;
  // Tracks the last non-whitespace char emitted at top level (out-of-string).
  // Only `{` and `,` are valid contexts where an unquoted key may follow;
  // any other prior char (e.g. `:` after a value, `[` opening a nested
  // array) means an identifier here is NOT a key — leave it alone.
  let lastTopChar = '';

  while (i < literal.length) {
    const c = literal[i];

    // ---- String value handling ----
    if (c === "'" || c === '"') {
      const quote = c;
      out += '"';
      i++;
      while (i < literal.length) {
        const ch = literal[i];
        if (ch === '\\') {
          // JSON accepts `\\`, `\"`, `\/`, `\n`, `\t`, `\r`, `\b`, `\f`,
          // `\uXXXX` — pass through. `\'` is invalid in JSON: convert to
          // bare `'`. Bundle-truncation guard: don't overshoot EOF.
          if (i + 1 >= literal.length) { i += 1; break; }
          if (literal[i + 1] === "'") { out += "'"; i += 2; continue; }
          out += ch + literal[i + 1];
          i += 2;
          continue;
        }
        if (ch === quote) { out += '"'; i++; break; }
        // Single-quoted source body containing a literal `"` must be escaped
        // for JSON. Double-quoted source bodies don't need this — `'` is
        // valid in both JS and JSON strings.
        if (quote === "'" && ch === '"') { out += '\\"'; i++; continue; }
        out += ch;
        i++;
      }
      lastTopChar = '"'; // string just closed
      continue;
    }

    // ---- Out-of-string: maybe an unquoted key starts here ----
    // Trigger conditions:
    //   - lastTopChar is `{` or `,` (we just opened an object or finished
    //     a previous key/value pair)
    //   - current char starts an identifier
    if ((lastTopChar === '{' || lastTopChar === ',')
        && /[A-Za-z_]/.test(c)) {
      // Read the identifier
      let j = i;
      while (j < literal.length && /[A-Za-z0-9_]/.test(literal[j])) j++;
      // Skip whitespace, expect `:`
      let k = j;
      while (k < literal.length && /\s/.test(literal[k])) k++;
      if (literal[k] === ':') {
        out += '"' + literal.slice(i, j) + '"' + literal.slice(j, k + 1);
        i = k + 1;
        lastTopChar = ':';
        continue;
      }
      // Identifier without trailing `:` → not a key (probably a literal
      // value like `null`, `true`, `false`, or unquoted JS that JSON.parse
      // will reject downstream). Pass through as-is.
      out += literal.slice(i, j);
      i = j;
      lastTopChar = literal[j - 1];
      continue;
    }

    // ---- Default pass-through ----
    out += c;
    if (!/\s/.test(c)) lastTopChar = c;
    i++;
  }
  return out;
}

/**
 * Enumerate every `var <name>=[{<key>:...},...]` plain-JS array in the bundle.
 * Sibling of iterateEvalResArrays for the pre-2026-04 / post-2026-05-revert
 * bundle format (plain JS object literals with unquoted keys, no eval
 * wrapper). Tries to JSON-ify each candidate by quoting unquoted keys, then
 * JSON.parse; silently skips candidates that don't parse.
 */
function* iteratePlainJSArrays(bundle) {
  // Anchor: word boundary + `var ` + identifier + `=[{` + key-like identifier + `:`
  // The trailing `<id>:` is what excludes unrelated `var x=[1,2,3]` arrays —
  // we only want object-of-objects arrays which is what VPD ships.
  const re = /\bvar\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*(\[)\s*\{\s*[A-Za-z_][A-Za-z0-9_]*\s*:/g;
  let m;
  while ((m = re.exec(bundle)) !== null) {
    const arrayOpen = m.index + m[0].lastIndexOf('[');
    const arrayClose = findArrayCloseInPlainJS(bundle, arrayOpen);
    if (arrayClose === -1) continue;
    const literal = bundle.slice(arrayOpen, arrayClose + 1);
    // Single-pass walker: converts JS string quoting → JSON string quoting
    // AND quotes unquoted keys after `{` or `,`. The walker tracks string
    // state, so the key-quoting step cannot misfire on a `,<ident>:` that
    // happens to live inside a string value (e.g. summary fields like
    // "Cases linked, date: 2026-05-01"). Pre-fix this was two passes and
    // codex round 4 P2 flagged the string-corruption hazard.
    const jsonForm = jsLiteralToJSON(literal);
    try {
      const array = JSON.parse(jsonForm);
      if (Array.isArray(array)) yield { array };
    } catch {
      // Bundle drift (e.g. an unquoted JS value like `undefined`/`NaN` or a
      // trailing comma) — skip and keep searching. The schema-fingerprint
      // matcher in findArrayBySchema will surface a clear error if no other
      // candidate matches.
    }
  }
}

/**
 * Find the first eval-block array whose records contain ALL of the named
 * fields. Schema-based identification — independent of key order within
 * objects, eval-block order in the bundle, and minor bundler shuffles.
 *
 * We sample multiple records (not just the first) because some upstream
 * systems emit sparse records where a field may be omitted on a single
 * row but present on others; a single-record check would false-negative.
 */
function findArrayBySchema(bundle, requiredFields) {
  const needed = new Set(requiredFields);
  // Try both bundle formats. The eval-wrapped form was added in the April
  // 2026 webpack rewrite; the plain-JS form is the pre-rewrite (and
  // post-2026-05-revert) shape. Either may be present in any given bundle
  // build, so we iterate both and accept the first schema match.
  const iterators = [iterateEvalResArrays(bundle), iteratePlainJSArrays(bundle)];
  for (const iterator of iterators) {
    for (const { array } of iterator) {
      if (array.length === 0) continue;
      // Sample up to 5 records to tolerate sparse fields on any single row.
      const sampleSize = Math.min(5, array.length);
      const seen = new Set();
      for (let i = 0; i < sampleSize; i++) {
        const r = array[i];
        if (!r || typeof r !== 'object') continue;
        for (const k of Object.keys(r)) seen.add(k);
      }
      let allPresent = true;
      for (const f of needed) {
        if (!seen.has(f)) { allPresent = false; break; }
      }
      if (allPresent) return array;
    }
  }
  return null;
}

export function parseRealtimeAlerts(bundle) {
  // Realtime alerts are identified by the (Alert_ID, lat, lng, diseases)
  // schema. Any reordering of these fields within a record (or across
  // records) is fine; only a real schema change (renamed field) breaks us.
  const rows = findArrayBySchema(bundle, ['Alert_ID', 'lat', 'lng', 'diseases']);
  if (!rows) {
    throw new Error('[VPD] no matching array block for realtime schema (Alert_ID, lat, lng, diseases) — tried both eval-wrapped + plain-JS formats; upstream format drift?');
  }
  return rows
    .filter((r) => r.lat && r.lng)
    .map((r) => ({
      alertId: r.Alert_ID,
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lng),
      disease: r.diseases,
      placeName: r.place_name,
      country: r.country,
      date: r.date,
      cases: r.cases ? parseInt(String(r.cases).replace(/,/g, ''), 10) || 0 : null,
      sourceUrl: r.link,
      summary: r.summary,
    }));
}

export function parseHistoricalData(bundle) {
  // Historical WHO counts identified by (country, iso, disease, year, cases).
  // 'cases' alone would also match realtime alerts so we use the full
  // schema fingerprint — the iso/disease/year combo is unique to historical.
  const rows = findArrayBySchema(bundle, ['country', 'iso', 'disease', 'year', 'cases']);
  if (!rows) {
    throw new Error('[VPD] no matching array block for historical schema (country, iso, disease, year, cases) — tried both eval-wrapped + plain-JS formats; upstream format drift?');
  }
  return rows.map((r) => ({
    country: r.country,
    iso: r.iso,
    disease: r.disease,
    year: parseInt(r.year, 10),
    cases: parseInt(r.cases, 10) || 0,
  }));
}

async function fetchVpdTracker() {
  const resp = await fetch(BUNDLE_URL, {
    headers: { 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`[VPD] Bundle fetch failed: HTTP ${resp.status}`);
  const bundle = await resp.text();

  const alerts = parseRealtimeAlerts(bundle);
  const historical = parseHistoricalData(bundle);

  console.log(`[VPD] Realtime alerts: ${alerts.length} | Historical records: ${historical.length}`);

  return { alerts, historical, fetchedAt: Date.now() };
}

function validate(data) {
  return Array.isArray(data?.alerts) && data.alerts.length >= 10
    && Array.isArray(data?.historical) && data.historical.length >= 100;
}

export function declareRecords(data) {
  return Array.isArray(data?.alerts) ? data.alerts.length : 0;
}

// Standalone-only entrypoint guard. Without this, importing the file from
// tests (e.g. to test parseRealtimeAlerts / parseHistoricalData) kicks off
// the full runSeed pipeline at module-load time — Redis lock acquisition,
// external bundle fetch, Redis writes — which hangs the test runner.
if (process.argv[1]?.endsWith('seed-vpd-tracker.mjs')) {
  runSeed('health', 'vpd-tracker', CANONICAL_KEY, fetchVpdTracker, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: 'tgh-bundle-v2',
    extraKeys: [
      {
        key: HISTORICAL_KEY,
        ttl: CACHE_TTL,
        transform: data => ({ records: data.historical, fetchedAt: data.fetchedAt }),
      },
    ],

    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 2880,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
