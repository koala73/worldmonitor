// Loader + validator for the re-export share manifest at
// scripts/shared/reexport-share-manifest.yaml.
//
// Mirrors the swf-manifest-loader.mjs pattern:
//   - Co-located with the YAML so the Railway recovery-bundle container
//     (rootDirectory=scripts/) ships both together under a single COPY.
//   - Pure JS (no Redis, no env mutations) so the SWF seeder can import
//     it at top-level without touching the I/O layer.
//   - Strict schema validation at load time so a malformed manifest
//     fails the seeder cold, not silently.
//
// See plan `docs/plans/2026-04-24-002-fix-resilience-cohort-ranking-
// structural-audit-plan.md` §PR 3A for the construct rationale.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(here, './reexport-share-manifest.yaml');

/**
 * @typedef {Object} ReexportShareEntry
 * @property {string} country                   ISO-3166-1 alpha-2
 * @property {number} reexportShareOfImports    0..1 inclusive
 * @property {number} year                      reference year (e.g. 2023)
 * @property {string} rationale                 one-line summary of the cited source
 * @property {string[]} sources                 list of URLs / citations
 */

/**
 * @typedef {Object} ReexportShareManifest
 * @property {number} manifestVersion
 * @property {string} lastReviewed
 * @property {'PENDING'|'REVIEWED'} externalReviewStatus
 * @property {ReexportShareEntry[]} countries
 */

function fail(msg) {
  throw new Error(`[reexport-manifest] ${msg}`);
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

function assertYear(value, path) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 2000 || value > 2100) {
    fail(`${path}: expected integer year in [2000, 2100], got ${JSON.stringify(value)}`);
  }
}

function validateSources(sources, path) {
  if (!Array.isArray(sources) || sources.length === 0) {
    fail(`${path}: expected non-empty array`);
  }
  for (const [srcIdx, src] of sources.entries()) {
    assertNonEmptyString(src, `${path}[${srcIdx}]`);
  }
  return sources.slice();
}

function validateCountryEntry(raw, idx, seenCountries) {
  const path = `countries[${idx}]`;
  if (!raw || typeof raw !== 'object') fail(`${path}: expected object`);
  const c = /** @type {Record<string, unknown>} */ (raw);

  assertIso2(c.country, `${path}.country`);
  assertZeroToOne(c.reexport_share_of_imports, `${path}.reexport_share_of_imports`);
  assertYear(c.year, `${path}.year`);
  assertNonEmptyString(c.rationale, `${path}.rationale`);
  const sources = validateSources(c.sources, `${path}.sources`);

  const countryCode = /** @type {string} */ (c.country);
  if (seenCountries.has(countryCode)) {
    fail(`${path}.country: duplicate entry for ${countryCode}`);
  }
  seenCountries.add(countryCode);

  return {
    country: countryCode,
    reexportShareOfImports: /** @type {number} */ (c.reexport_share_of_imports),
    year: /** @type {number} */ (c.year),
    rationale: /** @type {string} */ (c.rationale),
    sources,
  };
}

/**
 * Load and validate the re-export share manifest.
 * Throws with a detailed path-prefixed error on schema violation; a
 * broken manifest MUST fail the seeder cold — silently proceeding with
 * a partial read would leave some countries' net-imports denominator
 * wrong without signal.
 *
 * @returns {ReexportShareManifest}
 */
export function loadReexportShareManifest() {
  const raw = readFileSync(MANIFEST_PATH, 'utf8');
  const doc = parseYaml(raw);
  if (!doc || typeof doc !== 'object') {
    fail(`root: expected object, got ${typeof doc}`);
  }

  const version = doc.manifest_version;
  if (version !== 1) fail(`manifest_version: expected 1, got ${JSON.stringify(version)}`);

  const lastReviewed = doc.last_reviewed;
  if (typeof lastReviewed !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(lastReviewed)) {
    fail(`last_reviewed: expected YYYY-MM-DD, got ${JSON.stringify(lastReviewed)}`);
  }

  const status = doc.external_review_status;
  if (status !== 'PENDING' && status !== 'REVIEWED') {
    fail(`external_review_status: expected 'PENDING'|'REVIEWED', got ${JSON.stringify(status)}`);
  }

  const rawCountries = doc.countries;
  if (!Array.isArray(rawCountries)) {
    fail(`countries: expected array, got ${typeof rawCountries}`);
  }
  const seen = new Set();
  const countries = rawCountries.map((r, i) => validateCountryEntry(r, i, seen));

  return {
    manifestVersion: 1,
    lastReviewed,
    externalReviewStatus: /** @type {'PENDING'|'REVIEWED'} */ (status),
    countries,
  };
}

/**
 * Read the manifest and return an ISO2 → reexportShareOfImports lookup.
 * Countries missing from the manifest return undefined — the SWF seeder
 * MUST treat undefined as "no adjustment, use gross imports."
 *
 * @returns {Map<string, { reexportShareOfImports: number, year: number, sources: string[] }>}
 */
export function loadReexportShareByCountry() {
  const manifest = loadReexportShareManifest();
  const map = new Map();
  for (const entry of manifest.countries) {
    map.set(entry.country, {
      reexportShareOfImports: entry.reexportShareOfImports,
      year: entry.year,
      sources: entry.sources,
    });
  }
  return map;
}
