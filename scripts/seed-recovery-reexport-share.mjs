#!/usr/bin/env node
// seed-recovery-reexport-share
// ============================
//
// Publishes `resilience:recovery:reexport-share:v1` from the manifest
// at `scripts/shared/reexport-share-manifest.yaml`. The payload is
// consumed by `scripts/seed-sovereign-wealth.mjs` to convert gross
// annual imports into NET annual imports when computing the SWF
// `rawMonths` denominator (see plan §PR 3A of
// `docs/plans/2026-04-24-002-fix-resilience-cohort-ranking-structural-
// audit-plan.md`).
//
// Why a manifest-driven seeder and not a Comtrade fetcher: UNCTAD's
// Handbook of Statistics publishes re-export aggregates annually as
// PDF/Excel with no stable SDMX series for this specific derivative,
// and Comtrade's `flowCode=RX` has uneven coverage across reporters.
// A curated manifest with per-entry source citations is auditable and
// stable; the update cadence is annual (UNCTAD Handbook release).
//
// Revision cadence: manifest-edit PR at each UNCTAD Handbook release
// OR when a national stats office materially revises. Every revision
// must cite the source table / year.

import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import { loadReexportShareManifest } from './shared/reexport-share-loader.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'resilience:recovery:reexport-share:v1';
// Manifest content changes rarely (annual cadence). 30-day TTL is
// generous enough that a missed Railway tick doesn't evict the key
// before the next scheduled run, while short enough that an updated
// manifest propagates within a deploy cycle.
const CACHE_TTL = 30 * 24 * 3600;

async function fetchReexportShare() {
  const manifest = loadReexportShareManifest();
  const countries = {};
  for (const entry of manifest.countries) {
    countries[entry.country] = {
      reexportShareOfImports: entry.reexportShareOfImports,
      year: entry.year,
      sources: entry.sources,
    };
  }
  return {
    manifestVersion: manifest.manifestVersion,
    lastReviewed: manifest.lastReviewed,
    externalReviewStatus: manifest.externalReviewStatus,
    countries,
    seededAt: new Date().toISOString(),
  };
}

// Manifest may legitimately be empty (this PR ships empty + infrastructure;
// follow-up PRs populate entries with citations). `validateFn` thus accepts
// both the empty and populated cases — the goal is schema soundness, not a
// minimum-coverage gate. The SWF seeder treats absence as "use gross
// imports" so an empty manifest is a safe no-op.
function validate(data) {
  return (
    data != null
    && typeof data === 'object'
    && typeof data.countries === 'object'
    && data.countries !== null
    && typeof data.manifestVersion === 'number'
  );
}

export function declareRecords(data) {
  return Object.keys(data?.countries ?? {}).length;
}

runSeed('resilience', 'recovery:reexport-share', CANONICAL_KEY, fetchReexportShare, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'unctad-manifest-v1',
  declareRecords,
  schemaVersion: 1,
  // Note on empty-manifest behaviour. Our validate() returns true for
  // an empty manifest ({countries: {}}) — the schema is sound, the
  // content is just empty. runSeed therefore publishes the payload
  // normally. We intentionally do NOT pass emptyDataIsFailure (which
  // is strict-mode); an empty manifest on this PR's landing is the
  // legitimate shape pending follow-up PRs that add entries with
  // UNCTAD citations.
  //
  // Manifest cadence is weekly at most (bundle cron is weekly). Allow
  // generous staleness before health flags it — a manifest that's a
  // week old is perfectly fine because the underlying UNCTAD data
  // revision cadence is ANNUAL.
  maxStaleMin: 10080,
}).catch((err) => {
  const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + cause);
  process.exit(1);
});
