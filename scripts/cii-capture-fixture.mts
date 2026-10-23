#!/usr/bin/env node
// Captures one CII fixture from production Redis into tests/fixtures/cii/.
//
// Read-only: it issues Upstash REST GETs and nothing else, and never prints a
// credential. It reads every input the risk-scores build reads, plus the
// stored score table before and after, then trims the inputs
// (scripts/lib/cii-fixtures.mts), proves the trim leaves every term
// unchanged, and records the current formula's output. When the stored table
// was computed from the inputs read here, the fixture also proves the seam
// reproduces production; see docs/methodology/cii-change-brief.md.
//
//   WM_SEED_ENV_FILE=/path/to/.env.local node --import tsx scripts/cii-capture-fixture.mts [--iran-events-enabled=false]
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { getRedisCredentials, loadEnvFile } from './_seed-utils.mjs';
import { CII_FIXTURE_DIR, buildCiiFixture, ciiFiresInput, scoreCiiFixture } from './lib/cii-fixtures.mts';
import { CROSS_BORDER_SOURCES } from '../server/worldmonitor/displacement/v1/cross-border-data.ts';
import { unwrapEnvelope } from '../server/_shared/seed-envelope.ts';
import { CII_FORMULA_VERSION } from '../server/worldmonitor/intelligence/v1/_risk-config.ts';

const { values } = parseArgs({
  options: {
    'iran-events-enabled': { type: 'string', default: 'true' },
    // Inputs keep moving after a build, so a stored table minutes old no longer
    // matches them. Wait (GET-polling) for production's next rebuild first.
    'wait-for-rebuild': { type: 'boolean', default: false },
  },
});
const iranEventsEnabled = values['iran-events-enabled'] !== 'false';

loadEnvFile(import.meta.url);
const { url, token } = getRedisCredentials();

/** One GET. `envelope` keeps a seed envelope whole, as readCachedEnvelopeJson does. */
async function get(key: string, envelope = false): Promise<unknown> {
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'worldmonitor-cii-capture-fixture' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new Error(`GET ${key} failed: HTTP ${resp.status}`);
  const body = await resp.json() as { result?: string | null; error?: string };
  if (body.error) throw new Error(`GET ${key} failed: Redis error`);
  if (!body.result) return null;
  const parsed = JSON.parse(body.result);
  return envelope ? parsed : unwrapEnvelope(parsed).data;
}

type StoredTable = { ciiScores?: Array<{ region: string; combinedScore: number; computedAt: number; methodologyVersion: string }> } | null;
const scoreKey = `risk:scores:sebuf:${CII_FORMULA_VERSION}`;
let before = await get(scoreKey) as StoredTable;
if (values['wait-for-rebuild']) {
  const seen = before?.ciiScores?.[0]?.computedAt;
  const deadline = Date.now() + 30 * 60_000;
  while (before?.ciiScores?.[0]?.computedAt === seen) {
    if (Date.now() > deadline) throw new Error(`${scoreKey} was not rebuilt within 30 minutes`);
    await new Promise((done) => setTimeout(done, 5_000));
    before = await get(scoreKey) as StoredTable;
  }
}
const capturedAt = Date.now();
const year = new Date(capturedAt).getUTCFullYear();
const [
  ucdp, outages, climate, firesSummary, gpsjam, iranEvents, oref, advisories, displacementCurrent, newsInsights,
  threatSummary, aviation, earthquakes, sanctionsPressure, sanctionsCounts, temporalAnomalies, militaryCii,
  gdeltCountryEvents, strikePressure,
] = await Promise.all([
  'conflict:ucdp-events:v1', 'infra:outages:v1', 'climate:anomalies:v2', 'wildfire:fires-summary:v1',
  'intelligence:gpsjam:v2', 'conflict:iran-events:v1', 'relay:oref:history:v1', 'intelligence:advisories:v1',
  `displacement:summary:v1:${year}`, 'news:insights:v1', 'news:threat:summary:v1', 'aviation:delays-bootstrap:v2',
  'seismology:earthquakes:v1', 'sanctions:pressure:v1', 'sanctions:country-counts:v1', 'temporal:anomalies:v1',
  'intelligence:military-cii:v1', 'gdelt:bulk:country-events:v1', 'conflict:strike-pressure:v1',
].map((key) => get(key)));
const displacement = displacementCurrent ?? await get(`displacement:summary:v1:${year - 1}`);
const fires = ciiFiresInput(firesSummary, firesSummary == null ? await get('wildfire:fires:v1') : null);
const crossBorder = Object.fromEntries(await Promise.all(
  CROSS_BORDER_SOURCES.map(async (source) => [source.id, await get(source.key, true)] as const),
));
const after = await get(scoreKey) as StoredTable;

// Production's table matches these inputs only if it was not rebuilt while
// they were read; score at its computedAt so every age gate agrees.
const stored = after?.ciiScores?.length ? after : null;
if (stored && before?.ciiScores?.[0]?.computedAt !== stored.ciiScores![0]!.computedAt) {
  throw new Error(`${scoreKey} was rebuilt while the inputs were read; capture again`);
}
const nowMs = stored ? stored.ciiScores![0]!.computedAt : capturedAt;
const label = `${new Date(nowMs).toISOString().slice(0, 16).replace(':', '')}Z`;
const fixture = buildCiiFixture({
  ucdp, outages, climate, fires, gpsjam, iranEvents, oref, advisories, displacement, newsInsights, threatSummary,
  aviation, earthquakes, sanctionsPressure, sanctionsCounts, temporalAnomalies, militaryCii, gdeltCountryEvents,
  strikePressure, crossBorder,
}, {
  label,
  capturedAt: new Date(capturedAt).toISOString(),
  nowMs,
  iranEventsEnabled,
  notes: [
    stored
      ? `Inputs read GET-only from production Redis ${Math.round((capturedAt - nowMs) / 1000)} s after production computed ${scoreKey}.`
      : `Inputs read GET-only from production Redis; ${scoreKey} was not stored.`,
    ...['oref', 'threatSummary', 'gdeltCountryEvents', 'strikePressure', 'advisories']
      .filter((id) => ({ oref, threatSummary, gdeltCountryEvents, strikePressure, advisories } as Record<string, unknown>)[id] == null)
      .map((id) => `${id} was missing from Redis.`),
    'ACLED unconfigured.',
  ],
  production: stored ? {
    key: scoreKey,
    computedAt: nowMs,
    methodologyVersion: stored.ciiScores![0]!.methodologyVersion,
    scores: Object.fromEntries(stored.ciiScores!.map((s) => [s.region, s.combinedScore]).sort()),
  } : null,
});

// A fixture that carries production's table must reproduce it, or it would
// fail tests/cii-fixtures.test.mts: inputs that moved after the stored build
// are the usual cause, which --wait-for-rebuild avoids.
const table = scoreCiiFixture(fixture);
if (fixture.production) {
  const mismatches = table.scores
    .filter((s) => s.combinedScore !== fixture.production!.scores[s.region])
    .map((s) => `${s.region} seam ${s.combinedScore} vs stored ${fixture.production!.scores[s.region]}`);
  if (mismatches.length || Object.keys(fixture.production.scores).length !== table.scores.length) {
    throw new Error(`the seam does not reproduce ${scoreKey} (${mismatches.join(', ') || 'country sets differ'}); capture again with --wait-for-rebuild`);
  }
}
const path = resolve(CII_FIXTURE_DIR, `${label}.json`);
// Never replace a fixture: it may hold expected tables for earlier versions.
writeFileSync(path, `${JSON.stringify(fixture)}\n`, { flag: 'wx' });
console.log(`wrote ${path}`);
console.log(fixture.production
  ? `seam reproduces ${scoreKey} for ${table.scores.length}/${table.scores.length} countries`
  : 'no stored table to compare');
