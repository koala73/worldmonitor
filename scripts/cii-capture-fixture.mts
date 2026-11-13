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
// For U21: add --calibration --target-set=37 --wait-for-rebuild after verifying production prerequisites.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { getRedisCredentials, loadEnvFile } from './_seed-utils.mjs';
import { CII_FIXTURE_DIR, CII_EXPANDED_CAPTURE_TARGETS, buildCiiFixture, ciiFiresInput, scoreCiiFixture } from './lib/cii-fixtures.mts';
import { CROSS_BORDER_SOURCES } from '../server/worldmonitor/displacement/v1/cross-border-data.ts';
import { unwrapEnvelope } from '../server/_shared/seed-envelope.ts';
import { parsePartyMonths, statePartyIso2 } from './shared/ucdp-state-parties.cjs';
import { CII_COUNTRY_CODES } from '../shared/cii-weights.ts';
import { CII_ADVISORY_LAST_GOOD_KEY } from '../server/worldmonitor/intelligence/v1/get-risk-scores.ts';
import { CII_FORMULA_VERSION } from '../server/worldmonitor/intelligence/v1/_risk-config.ts';

const { values } = parseArgs({
  options: {
    'iran-events-enabled': { type: 'string', default: 'true' },
    // Inputs keep moving after a build, so a stored table minutes old no longer
    // matches them. Wait (GET-polling) for production's next rebuild first.
    'wait-for-rebuild': { type: 'boolean', default: false },
    calibration: { type: 'boolean', default: false },
    'target-set': { type: 'string', default: 'released' },
  },
});
const iranEventsEnabled = values['iran-events-enabled'] !== 'false';
if (!['released', '37'].includes(values['target-set']!)) throw new Error('--target-set must be released or 37');
const targetCodes = values['target-set'] === '37' ? CII_EXPANDED_CAPTURE_TARGETS : undefined;

const claim = JSON.parse(readFileSync(new URL('../docs/methodology/cii-next.json', import.meta.url), 'utf8'));
if (claim.inProgress === true) throw new Error('Capture requires a released main checkout, not an in-progress integration line');
if (values.calibration && !targetCodes) throw new Error('--calibration requires --target-set=37');

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
  gdeltCountryEvents, strikePressure, structuralPrior, economicStress,
] = await Promise.all([
  'conflict:ucdp-events:v1', 'infra:outages:v1', 'climate:anomalies:v2', 'wildfire:fires-summary:v1',
  'intelligence:gpsjam:v2', 'conflict:iran-events:v1', 'relay:oref:history:v1', 'intelligence:advisories:v1',
  `displacement:summary:v1:${year}`, 'news:insights:v1', 'news:threat:summary:v1', 'aviation:delays-bootstrap:v2',
  'seismology:earthquakes:v1', 'sanctions:pressure:v1', 'sanctions:country-counts:v1', 'temporal:anomalies:v1',
  'intelligence:military-cii:v1', 'gdelt:bulk:country-events:v1', 'conflict:strike-pressure:v1',
  'intelligence:cii-structural-prior:v1', 'intelligence:cii-economic-stress:v1',
].map((key) => get(key)));
const partyValue = (ucdp as { partyMonths?: unknown } | null)?.partyMonths;
const partyMonths = parsePartyMonths(partyValue);
if (partyValue !== undefined && partyMonths === null) throw new Error('Malformed full-window UCDP party table');
const scoredStates = new Set<string>(CII_COUNTRY_CODES);
const partyDeaths = partyMonths?.reduce((n, row) => n + row.deaths, 0) ?? 0;
const resolvedDeaths = partyMonths?.reduce((n, row) => n + ([row.sideA, row.sideB].some(side => scoredStates.has(statePartyIso2(side) ?? '')) ? row.deaths : 0), 0) ?? 0;
const partyNotes = partyMonths ? [
  `UCDP party table: ${partyMonths.length} groups; ${partyMonths.reduce((n, row) => n + row.events, 0)} events; ${partyDeaths} deaths; ${resolvedDeaths} deaths with at least one scored state party (no double counting).`,
  `UCDP payload bytes: ${Buffer.byteLength(JSON.stringify({ ...(ucdp as object), partyMonths: undefined }))} without party table; ${Buffer.byteLength(JSON.stringify(ucdp))} with table.`,
  `UCDP window: ${JSON.stringify((ucdp as { window?: unknown })?.window)}.`,
] : [];
const displacement = displacementCurrent ?? await get(`displacement:summary:v1:${year - 1}`);
const advisoriesLastGood = await get(CII_ADVISORY_LAST_GOOD_KEY);
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
if (values.calibration && !stored) throw new Error('Calibration capture requires a stored production table');
const nowMs = stored ? stored.ciiScores![0]!.computedAt : capturedAt;
const label = `${new Date(nowMs).toISOString().slice(0, 16).replace(':', '')}Z`;
const fixture = buildCiiFixture({
  ucdp, outages, climate, fires, gpsjam, iranEvents, oref, advisories, advisoriesLastGood, displacement, newsInsights, threatSummary,
  aviation, earthquakes, sanctionsPressure, sanctionsCounts, temporalAnomalies, militaryCii, gdeltCountryEvents,
  strikePressure, crossBorder, ...(economicStress != null ? { economicStress } : {}), ...(structuralPrior != null ? { structuralPrior } : {}),
}, {
  targetCodes,
  calibration: values.calibration,
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
    ...partyNotes,
    ...(values.calibration ? [`UCDP rows: ${(ucdp as any)?.events?.length ?? 0} recent events; ${Object.values((ucdp as any)?.countryDays ?? {}).reduce<number>((n, rows: any) => n + rows.length, 0)} country-day rows; ${(ucdp as any)?.dailyTotals?.length ?? 0} daily totals; ${partyMonths?.length ?? 0} party-month rows. Full window and both calibration keys retained without trimming.`] : []),
    ...(targetCodes ? ['Capture target: 37 countries; the released table still scores 31.'] : []),
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
