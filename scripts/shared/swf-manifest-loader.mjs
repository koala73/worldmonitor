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
 * @typedef {Object} SwfManifestEntry
 * @property {string} country       ISO-3166-1 alpha-2
 * @property {string} fund          short fund identifier (stable across runs)
 * @property {string} displayName   human-readable fund name
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
  const funds = rawFunds.map((raw, idx) => {
    const path = `funds[${idx}]`;
    if (!raw || typeof raw !== 'object') fail(`${path}: expected object`);
    const f = /** @type {Record<string, unknown>} */ (raw);

    assertIso2(f.country, `${path}.country`);
    assertNonEmptyString(f.fund, `${path}.fund`);
    assertNonEmptyString(f.display_name, `${path}.display_name`);

    const dedupeKey = `${f.country}:${f.fund}`;
    if (seenFundKeys.has(dedupeKey)) fail(`${path}: duplicate fund identifier ${dedupeKey}`);
    seenFundKeys.add(dedupeKey);

    const cls = f.classification;
    if (!cls || typeof cls !== 'object') fail(`${path}.classification: expected object`);
    const c = /** @type {Record<string, unknown>} */ (cls);
    assertZeroToOne(c.access,       `${path}.classification.access`);
    assertZeroToOne(c.liquidity,    `${path}.classification.liquidity`);
    assertZeroToOne(c.transparency, `${path}.classification.transparency`);

    const rat = f.rationale;
    if (!rat || typeof rat !== 'object') fail(`${path}.rationale: expected object`);
    const r = /** @type {Record<string, unknown>} */ (rat);
    assertNonEmptyString(r.access,       `${path}.rationale.access`);
    assertNonEmptyString(r.liquidity,    `${path}.rationale.liquidity`);
    assertNonEmptyString(r.transparency, `${path}.rationale.transparency`);

    const sources = f.sources;
    if (!Array.isArray(sources) || sources.length === 0) fail(`${path}.sources: expected non-empty array`);
    for (const [srcIdx, src] of sources.entries()) {
      assertNonEmptyString(src, `${path}.sources[${srcIdx}]`);
    }

    return {
      country: f.country,
      fund: f.fund,
      displayName: f.display_name,
      classification: {
        access: c.access,
        liquidity: c.liquidity,
        transparency: c.transparency,
      },
      rationale: {
        access: r.access,
        liquidity: r.liquidity,
        transparency: r.transparency,
      },
      sources: sources.slice(),
    };
  });

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
