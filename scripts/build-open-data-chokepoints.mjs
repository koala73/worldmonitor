#!/usr/bin/env node
// Build the daily open-data snapshot of WorldMonitor chokepoint status from the
// public GetChokepointStatus RPC. ROW_FIELDS is the published column contract:
// the JSON rows, the CSV header, and schema.json are all projected from it, so
// a field cannot ship in one format and not the others. WITHHELD_FIELDS records
// which API fields stay out of the dataset and why.
//
// Usage:
//   node scripts/build-open-data-chokepoints.mjs [--out <dir>] [--date YYYY-MM-DD] [--input <file>] [--dry-run]
//   API_BASE=https://www.worldmonitor.app WORLDMONITOR_API_KEY=<optional> node scripts/build-open-data-chokepoints.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { loadEnvFile, withRetry } from './_seed-utils.mjs';
import { isMainModule } from './lib/main-module.mjs';

loadEnvFile(import.meta.url, { only: ['WORLDMONITOR_API_KEY', 'API_BASE'] });

export const SCHEMA_VERSION = '1.0.0';
export const DATASET_ID = 'worldmonitor-chokepoint-status';
export const DEFAULT_API_BASE = 'https://www.worldmonitor.app';
export const RPC_PATH = '/api/supply-chain/v1/get-chokepoint-status';
export const DEFAULT_OUT_DIR = 'public/data/v1/chokepoints';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const HTTP_TIMEOUT_MS = 30_000;
const SNAPSHOT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATED_JSON_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;

const todayCount = (key) => (cp) => (cp.transitSummary?.todayCountsAvailable ? cp.transitSummary[key] : null);

export const ROW_FIELDS = [
  { name: 'id', type: 'string', nullable: false, description: 'Stable WorldMonitor chokepoint identifier.', from: (cp) => cp.id },
  { name: 'name', type: 'string', nullable: false, description: 'Chokepoint display name.', from: (cp) => cp.name },
  { name: 'lat', type: 'number', nullable: false, description: 'Latitude of the chokepoint reference point, decimal degrees.', from: (cp) => cp.lat },
  { name: 'lon', type: 'number', nullable: false, description: 'Longitude of the chokepoint reference point, decimal degrees.', from: (cp) => cp.lon },
  {
    name: 'status',
    type: 'string',
    nullable: false,
    enum: ['green', 'yellow', 'red'],
    description: 'Traffic-light badge for disruption_score: green (<20), yellow (20-49), red (>=50). Not an operational closure status.',
    from: (cp) => cp.status,
  },
  {
    name: 'disruption_score',
    type: 'integer',
    nullable: false,
    minimum: 0,
    maximum: 100,
    description: 'WorldMonitor composite disruption score, 0 (none) to 100 (severe).',
    from: (cp) => cp.disruptionScore,
  },
  {
    name: 'war_risk_tier',
    type: 'string',
    nullable: false,
    enum: ['unspecified', 'normal', 'elevated', 'high', 'critical', 'war_zone'],
    description: "War-risk tier derived from Lloyd's JWC Listed Areas and OSINT threat classification.",
    from: (cp) => (cp.warRiskTier || 'WAR_RISK_TIER_UNSPECIFIED').replace(/^WAR_RISK_TIER_/, '').toLowerCase(),
  },
  {
    name: 'congestion_level',
    type: 'string',
    nullable: true,
    enum: ['normal', 'low', 'elevated', 'high'],
    description: 'AIS-derived congestion level. Null when the AIS snapshot was unavailable.',
    from: (cp) => cp.congestionLevel,
  },
  { name: 'active_warnings', type: 'integer', nullable: false, description: 'Active NGA navigational warnings matched to the chokepoint.', from: (cp) => cp.activeWarnings },
  { name: 'ais_disruptions', type: 'integer', nullable: false, description: 'Disruption events in the AIS snapshot matched to the chokepoint.', from: (cp) => cp.aisDisruptions },
  {
    name: 'navigational_warnings_available',
    type: 'boolean',
    nullable: false,
    description: 'True when the NGA navigational-warning source returned a valid response, including an empty list.',
    from: (cp) => cp.navigationalWarningsAvailable,
  },
  {
    name: 'ais_snapshot_available',
    type: 'boolean',
    nullable: false,
    description: 'True when the AIS snapshot source returned a valid response. Governs ais_disruptions and congestion_level.',
    from: (cp) => cp.aisSnapshotAvailable,
  },
  {
    name: 'transit_data_available',
    type: 'boolean',
    nullable: false,
    description: 'True when IMF PortWatch transit history was available this cycle. Governs transit_wow_change_pct.',
    from: (cp) => cp.transitSummary?.dataAvailable === true,
  },
  {
    name: 'transit_today_counts_available',
    type: 'boolean',
    nullable: false,
    description: 'True when the 24-hour AIS window held crossings for this chokepoint. Governs the transit_today_* counts.',
    from: (cp) => cp.transitSummary?.todayCountsAvailable === true,
  },
  { name: 'transit_today_total', type: 'integer', nullable: true, description: 'AIS transits in the last 24 hours, all vessel types. Null when not measured.', from: todayCount('todayTotal') },
  { name: 'transit_today_tanker', type: 'integer', nullable: true, description: 'Tanker transits in the last 24 hours. Null when not measured.', from: todayCount('todayTanker') },
  { name: 'transit_today_cargo', type: 'integer', nullable: true, description: 'Cargo transits in the last 24 hours. Null when not measured.', from: todayCount('todayCargo') },
  { name: 'transit_today_other', type: 'integer', nullable: true, description: 'Other-vessel transits in the last 24 hours. Null when not measured.', from: todayCount('todayOther') },
  {
    name: 'transit_wow_change_pct',
    type: 'number',
    nullable: true,
    description: 'Week-over-week change in transits, percent. Null when transit history was unavailable.',
    from: (cp) => (cp.transitSummary?.dataAvailable ? cp.transitSummary.wowChangePct : null),
  },
  {
    name: 'flow_ratio',
    type: 'number',
    nullable: true,
    description: 'Latest 7-day PortWatch average over the preceding baseline window of up to 90 days, clamped to 0.0-1.5. Null when no flow estimate exists.',
    from: (cp) => cp.flowEstimate?.flowRatio,
  },
  {
    name: 'flow_disrupted',
    type: 'boolean',
    nullable: true,
    description: 'True when each of the latest 3 daily flow ratios is below 85% of the baseline window. Null when no flow estimate exists.',
    from: (cp) => cp.flowEstimate?.disrupted,
  },
  {
    name: 'flow_source',
    type: 'string',
    nullable: true,
    enum: ['portwatch-dwt', 'portwatch-counts'],
    description: 'PortWatch coverage basis of flow_ratio: deadweight tonnage or vessel counts. Null when no flow estimate exists.',
    from: (cp) => (cp.flowEstimate?.source === 'FLOW_SOURCE_UNSPECIFIED' ? null : cp.flowEstimate?.source),
  },
];

const CORRIDORRISK = 'CorridorRisk.io';
const EIA_BASELINE = 'U.S. EIA 2023 chokepoint reference levels';
const PORTWATCH_DISRUPTIONS = 'IMF PortWatch disruptions database';

export const WITHHELD_FIELDS = [
  { api_field: 'transitSummary.incidentCount7d', reason: 'Raw third-party incident count.', upstream: CORRIDORRISK },
  { api_field: 'transitSummary.disruptionPct', reason: 'Single third-party score, published as-is.', upstream: CORRIDORRISK },
  { api_field: 'transitSummary.riskLevel', reason: 'Banding of a single third-party score.', upstream: CORRIDORRISK },
  { api_field: 'flowEstimate.baselineMbd', reason: 'Third-party reference figure, not a WorldMonitor measurement.', upstream: EIA_BASELINE },
  { api_field: 'flowEstimate.currentMbd', reason: 'Equals baselineMbd times flowRatio, so it reveals the withheld baseline.', upstream: EIA_BASELINE },
  { api_field: 'flowEstimate.hazardAlertLevel', reason: 'Passthrough of a third-party hazard layer.', upstream: PORTWATCH_DISRUPTIONS },
  { api_field: 'flowEstimate.hazardAlertName', reason: 'Passthrough of a third-party hazard layer.', upstream: PORTWATCH_DISRUPTIONS },
  { api_field: 'transitSummary.history', reason: 'Raw third-party daily transit counts.', upstream: 'IMF PortWatch' },
  { api_field: 'transitSummary.riskSummary', reason: 'Third-party prose. The API already blanks it.', upstream: CORRIDORRISK },
  { api_field: 'transitSummary.riskReportAction', reason: 'Third-party prose. The API already blanks it.', upstream: CORRIDORRISK },
  { api_field: 'description', reason: 'Editorial prose, not data.', upstream: 'WorldMonitor editorial' },
  { api_field: 'affectedRoutes', reason: 'Static reference list, out of v1 scope.', upstream: 'WorldMonitor chokepoint registry' },
  { api_field: 'directions', reason: 'Static reference list, out of v1 scope.', upstream: 'WorldMonitor chokepoint registry' },
  { api_field: 'directionalDwt', reason: 'Deprecated per-direction tonnage, out of v1 scope.', upstream: 'IMF PortWatch' },
];

function projectValue(field, cp) {
  const raw = field.from(cp);
  const value = raw === '' || raw === undefined ? null : raw;
  if (value === null) {
    if (field.nullable) return null;
    throw new Error(`chokepoint ${cp.id}: ${field.name} is missing`);
  }
  const typeOk = field.type === 'integer' ? Number.isInteger(value) : typeof value === field.type;
  const enumOk = !field.enum || field.enum.includes(value);
  const rangeOk = (field.minimum === undefined || value >= field.minimum) && (field.maximum === undefined || value <= field.maximum);
  if (!typeOk || !enumOk || !rangeOk) {
    throw new Error(`chokepoint ${cp.id}: ${field.name} has unexpected value ${JSON.stringify(value)}`);
  }
  return value;
}

const projectRow = (cp) => Object.fromEntries(ROW_FIELDS.map((field) => [field.name, projectValue(field, cp)]));

export function buildSnapshot(apiResponse, { snapshotDate, generatedAt } = {}) {
  if (typeof snapshotDate !== 'string' || !SNAPSHOT_DATE_RE.test(snapshotDate)) {
    throw new Error(`snapshotDate must be YYYY-MM-DD, got ${JSON.stringify(snapshotDate)}`);
  }
  if (typeof generatedAt !== 'string' || Number.isNaN(Date.parse(generatedAt))) {
    throw new Error(`generatedAt must be an ISO 8601 timestamp, got ${JSON.stringify(generatedAt)}`);
  }
  const chokepoints = apiResponse?.chokepoints;
  if (!Array.isArray(chokepoints) || chokepoints.length === 0) {
    throw new Error('chokepoint status response has no chokepoints; refusing to publish an empty snapshot');
  }
  if (typeof apiResponse.fetchedAt !== 'string') {
    throw new Error('chokepoint status response has no fetchedAt');
  }
  return {
    schema_version: SCHEMA_VERSION,
    dataset: DATASET_ID,
    snapshot_date: snapshotDate,
    generated_at: generatedAt,
    source_url: `${DEFAULT_API_BASE}${RPC_PATH}`,
    source_fetched_at: apiResponse.fetchedAt,
    upstream_unavailable: apiResponse.upstreamUnavailable === true,
    methodology_url: `${DEFAULT_API_BASE}/docs/methodology/chokepoints`,
    readme_url: `${DEFAULT_API_BASE}/data/v1/chokepoints/README.md`,
    license: { proposed: 'CC-BY-4.0', status: 'proposed-pending-owner-decision' },
    attribution:
      'WorldMonitor (https://www.worldmonitor.app). Scores and statuses are computed by WorldMonitor from IMF PortWatch, NGA Maritime Safety Information, and AIS data via aisstream.io.',
    chokepoints: chokepoints.map(projectRow).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

function csvCell(value) {
  if (value === null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(snapshot) {
  const header = ['snapshot_date', ...ROW_FIELDS.map((field) => field.name)];
  const rows = snapshot.chokepoints.map((row) => [snapshot.snapshot_date, ...ROW_FIELDS.map((field) => row[field.name])]);
  return `${[header, ...rows].map((cells) => cells.map(csvCell).join(',')).join('\n')}\n`;
}

function fieldSchema(field) {
  return {
    type: field.nullable ? [field.type, 'null'] : field.type,
    ...(field.enum && { enum: field.nullable ? [...field.enum, null] : field.enum }),
    ...(field.minimum !== undefined && { minimum: field.minimum }),
    ...(field.maximum !== undefined && { maximum: field.maximum }),
    description: field.description,
  };
}

export function buildJsonSchema() {
  const rowNames = ROW_FIELDS.map((field) => field.name);
  const properties = {
    schema_version: { type: 'string', const: SCHEMA_VERSION },
    dataset: { type: 'string', const: DATASET_ID },
    snapshot_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'UTC calendar date the snapshot represents.' },
    generated_at: { type: 'string', format: 'date-time', description: 'When this file was generated.' },
    source_url: { type: 'string', description: 'Public API endpoint the snapshot was built from.' },
    source_fetched_at: { type: 'string', description: 'fetchedAt reported by the API response.' },
    upstream_unavailable: { type: 'boolean', description: 'True when the API reported that an upstream source was unavailable.' },
    methodology_url: { type: 'string' },
    readme_url: { type: 'string' },
    license: {
      type: 'object',
      required: ['proposed', 'status'],
      additionalProperties: false,
      properties: { proposed: { type: 'string' }, status: { type: 'string' } },
    },
    attribution: { type: 'string' },
    chokepoints: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: rowNames,
        additionalProperties: false,
        properties: Object.fromEntries(ROW_FIELDS.map((field) => [field.name, fieldSchema(field)])),
      },
    },
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${DEFAULT_API_BASE}/data/v1/chokepoints/schema.json`,
    title: 'WorldMonitor chokepoint status snapshot',
    type: 'object',
    required: Object.keys(properties),
    properties,
  };
}

const toJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

async function existingSnapshotDates(outDir) {
  try {
    return (await fs.readdir(outDir)).map((name) => DATED_JSON_RE.exec(name)?.[1]).filter(Boolean);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// latest.* only moves forward: replaying an older capture backfills its dated
// files without regressing what consumers of latest.json see.
async function planSnapshotFiles(outDir, snapshot) {
  const date = snapshot.snapshot_date;
  const dates = [...new Set([...(await existingSnapshotDates(outDir)), date])].sort();
  const latest = dates.at(-1);
  const json = toJson(snapshot);
  const csv = toCsv(snapshot);
  const files = [
    [`${date}.json`, json],
    [`${date}.csv`, csv],
    ...(date === latest ? [['latest.json', json], ['latest.csv', csv]] : []),
    ['schema.json', toJson(buildJsonSchema())],
    ['index.json', toJson({ schema_version: SCHEMA_VERSION, dataset: DATASET_ID, latest, dates })],
  ];
  return files.map(([name, contents]) => ({ path: path.join(outDir, name), contents }));
}

async function writeFileAtomic(filePath, contents) {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  try {
    await fs.writeFile(tmpPath, contents, { flag: 'wx' });
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true });
    throw err;
  }
}

export async function writeSnapshotFiles(outDir, snapshot) {
  await fs.mkdir(outDir, { recursive: true });
  const files = await planSnapshotFiles(outDir, snapshot);
  for (const file of files) await writeFileAtomic(file.path, file.contents);
  return files.map((file) => file.path);
}

async function requestJson(fetchImpl, url, init) {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!response.ok) {
    const err = new Error(`HTTP ${response.status} for ${url}`);
    err.status = response.status;
    err.nonRetryable = response.status >= 400 && response.status < 500 && response.status !== 429;
    throw err;
  }
  return response.json();
}

export async function fetchChokepointStatus({
  apiBase = DEFAULT_API_BASE,
  apiKey = '',
  userAgent = DEFAULT_USER_AGENT,
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  const base = apiBase.replace(/\/+$/, '');
  const headers = { 'User-Agent': userAgent, Accept: 'application/json', Origin: base, Referer: `${base}/` };
  if (apiKey) {
    headers['X-WorldMonitor-Key'] = apiKey;
  } else {
    const session = await requestJson(fetchImpl, `${base}/api/wm-session`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const token = String(session?.token ?? '').trim();
    if (!token) throw new Error('wm-session response did not include a token');
    headers.Cookie = `wm-session=${token}`;
  }
  return withRetry(() => requestJson(fetchImpl, `${base}${RPC_PATH}`, { method: 'GET', headers }));
}

async function readSavedResponse(file) {
  const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  return parsed?.body ?? parsed;
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: 'string' },
      date: { type: 'string' },
      input: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const outDir = values.out ? path.resolve(values.out) : path.join(REPO_ROOT, DEFAULT_OUT_DIR);
  const response = values.input
    ? await readSavedResponse(values.input)
    : await fetchChokepointStatus({
        apiBase: process.env.API_BASE || DEFAULT_API_BASE,
        apiKey: process.env.WORLDMONITOR_API_KEY || '',
        userAgent: process.env.USER_AGENT || DEFAULT_USER_AGENT,
      });
  const snapshot = buildSnapshot(response, {
    snapshotDate: values.date ?? new Date().toISOString().slice(0, 10),
    generatedAt: new Date().toISOString(),
  });
  console.log(
    `chokepoints=${snapshot.chokepoints.length} snapshot_date=${snapshot.snapshot_date} source_fetched_at=${snapshot.source_fetched_at}`,
  );
  if (values['dry-run']) {
    for (const file of await planSnapshotFiles(outDir, snapshot)) console.log(`would write ${file.path}`);
    return;
  }
  for (const written of await writeSnapshotFiles(outDir, snapshot)) console.log(`wrote ${written}`);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
