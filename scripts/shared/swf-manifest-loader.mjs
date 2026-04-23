// Loader + validator for the SWF classification manifest at
// docs/methodology/swf-classification-manifest.yaml.
//
// Shared between the seeder (scripts/seed-sovereign-wealth.mjs), the
// scorer unit tests, and the methodology-doc linter. Keep server-free
// (no Redis, no env mutations) so the server scorer can import it too
// once PR 2 lands its TypeScript counterpart.
//
// See plan §3.4 "Classification manifest and Norway example" for the
// three-component haircut definitions. This loader is the
// single-source-of-truth parser; do not hand-parse the YAML elsewhere.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(here, '../../docs/methodology/swf-classification-manifest.yaml');

/**
 * @typedef {Object} SwfClassification
 * @property {number} access       0..1 inclusive
 * @property {number} liquidity    0..1 inclusive
 * @property {number} transparency 0..1 inclusive
 */

/**
 * @typedef {Object} SwfWikipediaHints
 * @property {string} [abbrev]     matches the "Abbrev." column on the
 *                                 Wikipedia `List_of_sovereign_wealth_funds`
 *                                 article (case- and punctuation-normalized)
 * @property {string} [fundName]   matches the "Fund name" column
 * @property {string} [articleUrl] per-fund Wikipedia article URL used by the
 *                                 Tier 3b infobox fallback when the list
 *                                 article does not include the fund
 *                                 (Temasek is the canonical case)
 */

/**
 * @typedef {Object} SwfManifestEntry
 * @property {string} country       ISO-3166-1 alpha-2
 * @property {string} fund          short fund identifier (stable across runs)
 * @property {string} displayName   human-readable fund name
 * @property {SwfWikipediaHints} [wikipedia] optional lookup hints for the
 *                                           Wikipedia fallback scraper
 * @property {SwfClassification} classification
 * @property {{ access: string, liquidity: string, transparency: string }} rationale
 * @property {string[]} sources
 */

/**
 * @typedef {Object} SwfManifest
 * @property {number} manifestVersion
 * @property {string} lastReviewed
 * @property {'PENDING'|'REVIEWED'} externalReviewStatus
 * @property {SwfManifestEntry[]} funds
 */

function fail(msg) {
  throw new Error(`[swf-manifest] ${msg}`);
}

function assertZeroToOne(value, path) {
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0 || value > 1) {
    fail(`${path}: expected number in [0, 1], got ${JSON.stringify(value)}`);
  }
}

function assertIso2(value, path) {
  if (typeof value !== 'string' || !/^[A-Z]{2}$/.test(value)) {
    fail(`${path}: expected ISO-3166-1 alpha-2 country code, got ${JSON.stringify(value)}`);
  }
}

function assertNonEmptyString(value, path) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${path}: expected non-empty string, got ${JSON.stringify(value)}`);
  }
}

function validateClassification(cls, path) {
  if (!cls || typeof cls !== 'object') fail(`${path}: expected object`);
  const c = /** @type {Record<string, unknown>} */ (cls);
  assertZeroToOne(c.access,       `${path}.access`);
  assertZeroToOne(c.liquidity,    `${path}.liquidity`);
  assertZeroToOne(c.transparency, `${path}.transparency`);
  return { access: c.access, liquidity: c.liquidity, transparency: c.transparency };
}

function validateRationale(rat, path) {
  if (!rat || typeof rat !== 'object') fail(`${path}: expected object`);
  const r = /** @type {Record<string, unknown>} */ (rat);
  assertNonEmptyString(r.access,       `${path}.access`);
  assertNonEmptyString(r.liquidity,    `${path}.liquidity`);
  assertNonEmptyString(r.transparency, `${path}.transparency`);
  return { access: r.access, liquidity: r.liquidity, transparency: r.transparency };
}

function validateSources(sources, path) {
  if (!Array.isArray(sources) || sources.length === 0) fail(`${path}: expected non-empty array`);
  for (const [srcIdx, src] of sources.entries()) {
    assertNonEmptyString(src, `${path}[${srcIdx}]`);
  }
  return sources.slice();
}

// Optional wikipedia hints — used by the Wikipedia fallback scraper
// in scripts/seed-sovereign-wealth.mjs. Either `abbrev` or `fund_name`
// must be present if the block is present (otherwise the scraper has
// nothing to match against). `article_url` is optional and activates
// the Tier 3b per-fund infobox fallback.
function validateWikipediaHints(block, path) {
  if (block == null) return undefined;
  if (typeof block !== 'object') fail(`${path}: expected object`);
  const w = /** @type {Record<string, unknown>} */ (block);
  const abbrev = w.abbrev;
  const fundName = w.fund_name;
  const articleUrl = w.article_url;
  if (abbrev != null && typeof abbrev !== 'string') {
    fail(`${path}.abbrev: expected string, got ${JSON.stringify(abbrev)}`);
  }
  if (fundName != null && typeof fundName !== 'string') {
    fail(`${path}.fund_name: expected string, got ${JSON.stringify(fundName)}`);
  }
  if (articleUrl != null) {
    if (typeof articleUrl !== 'string') {
      fail(`${path}.article_url: expected string, got ${JSON.stringify(articleUrl)}`);
    }
    if (!/^https:\/\/[a-z]{2,3}\.wikipedia\.org\//.test(articleUrl)) {
      fail(`${path}.article_url: expected a https://<lang>.wikipedia.org/... URL, got ${JSON.stringify(articleUrl)}`);
    }
  }
  if (!abbrev && !fundName) {
    fail(`${path}: at least one of abbrev or fund_name must be provided`);
  }
  return {
    ...(abbrev ? { abbrev } : {}),
    ...(fundName ? { fundName } : {}),
    ...(articleUrl ? { articleUrl } : {}),
  };
}

function validateFundEntry(raw, idx, seenFundKeys) {
  const path = `funds[${idx}]`;
  if (!raw || typeof raw !== 'object') fail(`${path}: expected object`);
  const f = /** @type {Record<string, unknown>} */ (raw);

  assertIso2(f.country, `${path}.country`);
  assertNonEmptyString(f.fund, `${path}.fund`);
  assertNonEmptyString(f.display_name, `${path}.display_name`);

  const dedupeKey = `${f.country}:${f.fund}`;
  if (seenFundKeys.has(dedupeKey)) fail(`${path}: duplicate fund identifier ${dedupeKey}`);
  seenFundKeys.add(dedupeKey);

  const classification = validateClassification(f.classification, `${path}.classification`);
  const rationale = validateRationale(f.rationale, `${path}.rationale`);
  const sources = validateSources(f.sources, `${path}.sources`);
  const wikipedia = validateWikipediaHints(f.wikipedia, `${path}.wikipedia`);

  return {
    country: f.country,
    fund: f.fund,
    displayName: f.display_name,
    ...(wikipedia ? { wikipedia } : {}),
    classification,
    rationale,
    sources,
  };
}

/**
 * Validate and normalize a raw parsed manifest object into the
 * documented schema. Fails loudly on any deviation — the manifest is
 * supposed to be hand-maintained and reviewer-approved, so silent
 * coercion would hide errors.
 *
 * @param {unknown} raw
 * @returns {SwfManifest}
 */
export function validateManifest(raw) {
  if (!raw || typeof raw !== 'object') fail('manifest root must be an object');
  const obj = /** @type {Record<string, unknown>} */ (raw);

  const manifestVersion = obj.manifest_version;
  if (manifestVersion !== 1) fail(`manifest_version: expected 1, got ${JSON.stringify(manifestVersion)}`);

  const lastReviewed = obj.last_reviewed;
  if (!(lastReviewed instanceof Date) && typeof lastReviewed !== 'string') {
    fail(`last_reviewed: expected ISO date string or Date, got ${JSON.stringify(lastReviewed)}`);
  }
  const lastReviewedStr = lastReviewed instanceof Date
    ? lastReviewed.toISOString().slice(0, 10)
    : lastReviewed;

  const externalReviewStatus = obj.external_review_status;
  if (externalReviewStatus !== 'PENDING' && externalReviewStatus !== 'REVIEWED') {
    fail(`external_review_status: expected 'PENDING' or 'REVIEWED', got ${JSON.stringify(externalReviewStatus)}`);
  }

  const rawFunds = obj.funds;
  if (!Array.isArray(rawFunds)) fail('funds: expected array');
  if (rawFunds.length === 0) fail('funds: must list at least one fund');

  const seenFundKeys = new Set();
  const funds = rawFunds.map((raw, idx) => validateFundEntry(raw, idx, seenFundKeys));

  return {
    manifestVersion,
    lastReviewed: lastReviewedStr,
    externalReviewStatus,
    funds,
  };
}

/**
 * Load + validate the manifest YAML from disk.
 *
 * @param {string} [path] optional override for tests
 * @returns {SwfManifest}
 */
export function loadSwfManifest(path = MANIFEST_PATH) {
  const raw = readFileSync(path, 'utf8');
  const parsed = parseYaml(raw);
  return validateManifest(parsed);
}

/**
 * Index the manifest by ISO-2 country code so downstream callers can
 * aggregate multiple funds per country without re-scanning the array.
 *
 * @param {SwfManifest} manifest
 * @returns {Map<string, SwfManifestEntry[]>}
 */
export function groupFundsByCountry(manifest) {
  const byCountry = new Map();
  for (const fund of manifest.funds) {
    const list = byCountry.get(fund.country) ?? [];
    list.push(fund);
    byCountry.set(fund.country, list);
  }
  return byCountry;
}

export const __TEST_ONLY = { MANIFEST_PATH };
