// Plan 2026-04-26-002 §U2 (PR 1, review fixup) — server-side mirror
// of `scripts/shared/rankable-universe.mjs`.
//
// Both modules read the SAME canonical JSON at
// `scripts/shared/sovereign-status.json` — the .mjs version uses
// fs.readFileSync (so seeders can run under plain `node`); this .ts
// version uses an ES JSON import (so server handlers can use Vercel's
// bundler). The two are guaranteed to agree because they read the
// same source file; the duplication is the read-path, not the data.
//
// **Location reason**: the seed-bundle-resilience Railway service
// runs with rootDirectory=scripts/ and only ships files under
// scripts/ (memory: `worldmonitor-scripts-package-json-install-scope`).
// PR #3435 originally placed the JSON under server/.../registries/
// — that resolved fine locally and on Vercel but ENOENT'd at Railway
// runtime, taking the resilience cron down. Hotfix relocated to
// scripts/shared/.
//
// **Why both surfaces matter**: PR #3435 added the universe filter
// at universe-build time in `seed-resilience-static.mjs`, but reviewer
// found that `listScorableCountries` in `_shared.ts:661` reads
// `manifest.countries` directly from Redis. If the static index is
// stale (or seeded by a pre-PR-1 build), the ranking handler would
// still serve all 222 countries. Defense-in-depth: filter at the
// handler-side read too, so the rankable-universe contract is
// enforced regardless of seed state.

// Plain JSON import (no `with { type: 'json' }` attribute) matches
// the rest of the codebase. Vercel's esbuild bundler does NOT
// support the import-attribute syntax. Sibling modules use the
// same plain-import shape from scripts/shared/:
//   `import iso2ToIso3Json from '../../../../shared/iso2-to-iso3.json';`
// (see _dimension-scorers.ts:1-2).
import sovereignStatus from '../../../../scripts/shared/sovereign-status.json';

export type SovereignStatus = 'un-member' | 'sar';

interface SovereignStatusEntry {
  iso2: string;
  status: SovereignStatus;
}

interface SovereignStatusFile {
  name: string;
  description: string;
  entries: SovereignStatusEntry[];
}

const FILE = sovereignStatus as SovereignStatusFile;

const RANKABLE_UNIVERSE: ReadonlyMap<string, SovereignStatus> = new Map(
  FILE.entries
    .filter((e) => e?.iso2 && (e.status === 'un-member' || e.status === 'sar'))
    .map((e) => [e.iso2.toUpperCase(), e.status]),
);

/** Is this country in the rankable universe (UN member or recognized SAR)? */
export function isInRankableUniverse(iso2: string): boolean {
  if (typeof iso2 !== 'string' || iso2.length !== 2) return false;
  return RANKABLE_UNIVERSE.has(iso2.toUpperCase());
}

/** Sovereign status of a rankable country, or null if not eligible. */
export function getSovereignStatus(iso2: string): SovereignStatus | null {
  if (typeof iso2 !== 'string') return null;
  return RANKABLE_UNIVERSE.get(iso2.toUpperCase()) ?? null;
}

export const RANKABLE_UNIVERSE_SIZE = RANKABLE_UNIVERSE.size;
