// Plan 2026-04-26-002 §U2 (PR 1) — single source of truth for the
// "what's a country in the headline ranking" decision.
//
// Reads the committed JSON whitelist at
// `scripts/shared/sovereign-status.json` (193 UN member states + 3
// standalone SARs: HK, MO, TW).
//
// **Why scripts/shared/ and NOT server/.../cohorts/ or registries/:**
// the seed-bundle-resilience Railway service runs with rootDirectory=scripts/
// and ONLY ships files under scripts/ into the container (memory:
// `worldmonitor-scripts-package-json-install-scope`). PR #3435 originally
// put the JSON under `server/.../registries/` — that resolved fine
// locally and on Vercel but ENOENT'd at Railway runtime, taking the
// resilience cron down. `scripts/shared/` is the canonical location
// for shared JSON consumed by both seeders and server-side code
// (alongside iso2-to-iso3.json, country-names.json etc.).
//
// The JSON shape is a per-country PROPERTY registry
// (`{ entries: [{iso2, status}] }`), not a cohort membership list.
// PR #3433's cohort shape gate scans `server/.../cohorts/` and would
// reject this file's shape; living in `scripts/shared/` keeps it
// outside that gate's scope.
//
// Both seeders (`scripts/seed-resilience-static.mjs` and
// `scripts/seed-resilience-scores.mjs`) consume `isInRankableUniverse`
// to ensure their universes match. Earlier behavior: the static seeder
// admitted every ISO2 from any source map (~222 entries including
// AS/GU/GL/IM/GI/FK). Post-PR-1: ~196 entries.
//
// HK/MO/TW are tagged `sar` so they remain in the dataset but can be
// separated by the `headlineEligible` gate in PR 2/6 if/when that
// policy ships.
//
// Implementation: reads via fs.readFileSync (rather than ES JSON
// import) so this module works under plain `node` without an import-
// assertion or tsx loader. The same JSON is also read by
// `tests/resilience-cohort-anti-inversion.test.mts` via the same
// pattern.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// Sibling JSON in the same scripts/shared/ directory — no path
// traversal, no cross-directory dependency, container-safe.
const SOVEREIGN_STATUS_PATH = resolve(here, 'sovereign-status.json');

const RANKABLE_UNIVERSE = (() => {
  const raw = readFileSync(SOVEREIGN_STATUS_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  const map = new Map();
  for (const entry of parsed.entries) {
    if (entry?.iso2 && (entry.status === 'un-member' || entry.status === 'sar')) {
      map.set(entry.iso2.toUpperCase(), entry.status);
    }
  }
  return map;
})();

/**
 * Is this country in the rankable universe (UN member or recognized SAR)?
 * Case-insensitive on iso2.
 *
 * @param {string} iso2
 * @returns {boolean}
 */
export function isInRankableUniverse(iso2) {
  if (typeof iso2 !== 'string' || iso2.length !== 2) return false;
  return RANKABLE_UNIVERSE.has(iso2.toUpperCase());
}

/**
 * Get the sovereign status of a rankable country, or null if not eligible.
 * @param {string} iso2
 * @returns {'un-member' | 'sar' | null}
 */
export function getSovereignStatus(iso2) {
  if (typeof iso2 !== 'string') return null;
  return RANKABLE_UNIVERSE.get(iso2.toUpperCase()) ?? null;
}

/**
 * Returns the full list of rankable ISO2 codes, sorted alphabetically.
 * Used for diagnostics/tests; not for hot paths.
 * @returns {string[]}
 */
export function listRankableCountries() {
  return [...RANKABLE_UNIVERSE.keys()].sort();
}

export const RANKABLE_UNIVERSE_SIZE = RANKABLE_UNIVERSE.size;
