// Global-Tenders runs once a day: government portals publish tenders daily and they
// stay open for weeks, so hourly polling bought nothing and drew upstream blocks
// (DGCP has answered every request with a Cloudflare challenge since 2026-11-13).
// Every window that health, the RPC and the seeder grade freshness against is
// sized from that one cadence; this test keeps them from drifting apart again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { __testing__ as health } from '../api/health.js';
import { TENDER_SOURCE_RETENTION_MS } from '../scripts/_global-tenders.mjs';
import { CACHE_TTL_SECONDS, SOURCE_STATUS_TTL_SECONDS } from '../scripts/seed-global-tenders.mjs';
import { STALE_AFTER_MS } from '../server/worldmonitor/economic/v1/list-global-tenders.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const DAY_MIN = 1440;
// Three missed daily runs, the house staleness multiple.
const BUDGET_MIN = 3 * DAY_MIN;
const { SEED_META } = health;
const perSourceNames = Object.keys(SEED_META)
  .filter((name) => name.startsWith('globalTenders') && name !== 'globalTenders');

test('the bundle runs the Global-Tenders section once a day', () => {
  const line = read('scripts/seed-bundle-relay-backup.mjs').split('\n').find((l) => l.includes("label: 'Global-Tenders'"));
  assert.match(line, /intervalMs: DAY,/);
});

test('health allows three missed daily runs for the aggregate and every source', () => {
  assert.equal(SEED_META.globalTenders.maxStaleMin, BUDGET_MIN);
  assert.ok(perSourceNames.length >= 22, `found ${perSourceNames.length} per-source checks`);
  for (const name of perSourceNames) assert.equal(SEED_META[name].maxStaleMin, BUDGET_MIN, name);
});

test('retained rows last as long as health tolerates the source being stale', () => {
  assert.equal(TENDER_SOURCE_RETENTION_MS, BUDGET_MIN * 60_000);
});

test('stored keys outlive the staleness budget, so a stale source reads STALE_SEED before EMPTY', () => {
  // At least one full daily run of STALE_SEED before the key expires.
  assert.ok(CACHE_TTL_SECONDS * 1000 >= BUDGET_MIN * 60_000 + DAY_MIN * 60_000);
  assert.ok(SOURCE_STATUS_TTL_SECONDS * 1000 >= TENDER_SOURCE_RETENTION_MS + DAY_MIN * 60_000);
});

test('the RPC labels the snapshot stale on the same budget as health', () => {
  assert.equal(STALE_AFTER_MS, BUDGET_MIN * 60_000);
});
