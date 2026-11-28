import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  ATTRIBUTION,
  CONSUMED_FIELDS,
  LICENSE,
  ROW_FIELDS,
  SCHEMA_VERSION,
  WITHHELD_FIELDS,
  buildJsonSchema,
  buildSnapshot,
  fetchChokepointStatus,
  toCsv,
  writeSnapshotFiles,
} from '../scripts/build-open-data-chokepoints.mjs';

const FIXTURE_2026_09_10 = new URL('./fixtures/chokepoints-routing-advice-2026-09-10.json', import.meta.url);
const FIXTURE_2026_11_02 = new URL('./fixtures/chokepoints-status-2026-11-02.json', import.meta.url);
const GENERATOR = fileURLToPath(new URL('../scripts/build-open-data-chokepoints.mjs', import.meta.url));
const fixtureBody = JSON.parse(readFileSync(FIXTURE_2026_09_10, 'utf8')).body;
// Captured after #10001 added the PortWatch official_*/baseline_* fields, so it
// carries every field the endpoint serves today.
const liveBody = JSON.parse(readFileSync(FIXTURE_2026_11_02, 'utf8')).body;
const OPTIONS = { snapshotDate: '2026-09-10', generatedAt: '2026-09-10T07:00:00.000Z' };
const run = promisify(execFile);

const ROW_NAMES = [
  'id',
  'name',
  'lat',
  'lon',
  'status',
  'disruption_score',
  'war_risk_tier',
  'congestion_level',
  'active_warnings',
  'ais_disruptions',
  'navigational_warnings_available',
  'ais_snapshot_available',
  'transit_data_available',
  'transit_today_counts_available',
  'transit_today_total',
  'transit_today_tanker',
  'transit_today_cargo',
  'transit_today_other',
  'transit_wow_change_pct',
  'flow_ratio',
  'flow_disrupted',
  'flow_source',
];

const SORTED_IDS = [
  'bab_el_mandeb',
  'bosphorus',
  'cape_of_good_hope',
  'dover_strait',
  'gibraltar',
  'hormuz_strait',
  'kerch_strait',
  'korea_strait',
  'lombok_strait',
  'malacca_strait',
  'panama',
  'suez',
  'taiwan_strait',
];

const minimalChokepoint = (overrides) => ({
  id: 'test_strait',
  name: 'Test Strait',
  lat: 1,
  lon: 2,
  disruptionScore: 0,
  status: 'green',
  activeWarnings: 0,
  aisDisruptions: 0,
  congestionLevel: '',
  navigationalWarningsAvailable: false,
  aisSnapshotAvailable: false,
  warRiskTier: 'WAR_RISK_TIER_UNSPECIFIED',
  ...overrides,
});

const minimalResponse = (chokepoints) => ({ chokepoints, fetchedAt: '2026-09-10T06:00:00.000Z', upstreamUnavailable: false });

const rowById = (snapshot, id) => snapshot.chokepoints.find((row) => row.id === id);

describe('open data chokepoint snapshot schema', () => {
  it('pins the published column order, schema version, and envelope keys', () => {
    assert.deepEqual(
      ROW_FIELDS.map((field) => field.name),
      ROW_NAMES,
    );
    assert.equal(SCHEMA_VERSION, '1.0.0');
    assert.deepEqual(buildJsonSchema().properties.chokepoints.items.required, ROW_NAMES);
    assert.deepEqual(Object.keys(buildSnapshot(fixtureBody, OPTIONS)), [
      'schema_version',
      'dataset',
      'snapshot_date',
      'generated_at',
      'source_url',
      'source_fetched_at',
      'upstream_unavailable',
      'methodology_url',
      'readme_url',
      'license',
      'attribution',
      'chokepoints',
    ]);
  });

  it('lets a nullable enum column hold null and bounds disruption_score', () => {
    const rowSchema = buildJsonSchema().properties.chokepoints.items;
    assert.equal(rowSchema.additionalProperties, false);
    assert.deepEqual(rowSchema.properties.congestion_level.type, ['string', 'null']);
    assert.deepEqual(rowSchema.properties.congestion_level.enum, ['normal', 'low', 'elevated', 'high', null]);
    assert.equal(rowSchema.properties.disruption_score.type, 'integer');
    assert.equal(rowSchema.properties.disruption_score.minimum, 0);
    assert.equal(rowSchema.properties.disruption_score.maximum, 100);
  });

  it('bounds flow_ratio to the 0.0-1.5 clamp its description promises', () => {
    const flowRatio = buildJsonSchema().properties.chokepoints.items.properties.flow_ratio;
    assert.deepEqual(flowRatio.type, ['number', 'null']);
    assert.equal(flowRatio.minimum, 0);
    assert.equal(flowRatio.maximum, 1.5);
  });

  it('grants CC BY 4.0 in every file and pins the grant and attribution in the schema', () => {
    const snapshot = buildSnapshot(fixtureBody, OPTIONS);
    assert.deepEqual(snapshot.license, { spdx: 'CC-BY-4.0', url: 'https://creativecommons.org/licenses/by/4.0/' });
    assert.deepEqual(snapshot.license, { ...LICENSE });
    assert.equal(snapshot.attribution, ATTRIBUTION);
    assert.match(ATTRIBUTION, /^WorldMonitor \(https:\/\/www\.worldmonitor\.app\)\./);
    const { license, attribution } = buildJsonSchema().properties;
    assert.deepEqual(license.required, ['spdx', 'url']);
    assert.equal(license.additionalProperties, false);
    assert.equal(license.properties.spdx.const, 'CC-BY-4.0');
    assert.equal(license.properties.url.const, 'https://creativecommons.org/licenses/by/4.0/');
    assert.equal(attribution.const, ATTRIBUTION);
  });
});

describe('open data chokepoint row projection', () => {
  it('projects the real 2026-09-10 capture into rows sorted by id', () => {
    const snapshot = buildSnapshot(fixtureBody, OPTIONS);
    assert.deepEqual(
      snapshot.chokepoints.map((row) => row.id),
      SORTED_IDS,
    );
    assert.equal(snapshot.source_fetched_at, '2026-09-10T06:50:30.970Z');
    assert.equal(snapshot.upstream_unavailable, false);
    assert.equal(snapshot.source_url, 'https://www.worldmonitor.app/api/supply-chain/v1/get-chokepoint-status');
  });

  it('withholds unmeasured today counts and keeps the flow estimate for hormuz_strait', () => {
    assert.deepEqual(rowById(buildSnapshot(fixtureBody, OPTIONS), 'hormuz_strait'), {
      id: 'hormuz_strait',
      name: 'Strait of Hormuz',
      lat: 26.56,
      lon: 56.25,
      status: 'red',
      disruption_score: 70,
      war_risk_tier: 'war_zone',
      congestion_level: 'normal',
      active_warnings: 0,
      ais_disruptions: 0,
      navigational_warnings_available: true,
      ais_snapshot_available: true,
      transit_data_available: true,
      transit_today_counts_available: false,
      transit_today_total: null,
      transit_today_tanker: null,
      transit_today_cargo: null,
      transit_today_other: null,
      transit_wow_change_pct: -26.7,
      flow_ratio: 0.122,
      flow_disrupted: true,
      flow_source: 'portwatch-dwt',
    });
  });

  it('publishes measured today counts and nulls the absent flow estimate for taiwan_strait', () => {
    assert.deepEqual(rowById(buildSnapshot(fixtureBody, OPTIONS), 'taiwan_strait'), {
      id: 'taiwan_strait',
      name: 'Taiwan Strait',
      lat: 24,
      lon: 119.5,
      status: 'yellow',
      disruption_score: 20,
      war_risk_tier: 'elevated',
      congestion_level: 'low',
      active_warnings: 0,
      ais_disruptions: 1,
      navigational_warnings_available: true,
      ais_snapshot_available: true,
      transit_data_available: true,
      transit_today_counts_available: true,
      transit_today_total: 4,
      transit_today_tanker: 0,
      transit_today_cargo: 3,
      transit_today_other: 1,
      transit_wow_change_pct: 17.8,
      flow_ratio: null,
      flow_disrupted: null,
      flow_source: null,
    });
  });

  it('maps a sparse row: no summaries, empty congestion, unspecified tier', () => {
    const snapshot = buildSnapshot(minimalResponse([minimalChokepoint({})]), OPTIONS);
    assert.deepEqual(snapshot.chokepoints, [
      {
        id: 'test_strait',
        name: 'Test Strait',
        lat: 1,
        lon: 2,
        status: 'green',
        disruption_score: 0,
        war_risk_tier: 'unspecified',
        congestion_level: null,
        active_warnings: 0,
        ais_disruptions: 0,
        navigational_warnings_available: false,
        ais_snapshot_available: false,
        transit_data_available: false,
        transit_today_counts_available: false,
        transit_today_total: null,
        transit_today_tanker: null,
        transit_today_cargo: null,
        transit_today_other: null,
        transit_wow_change_pct: null,
        flow_ratio: null,
        flow_disrupted: null,
        flow_source: null,
      },
    ]);
  });

  it('projects the 2026-11-02 capture, which carries the PortWatch official fields', () => {
    const snapshot = buildSnapshot(liveBody, { snapshotDate: '2026-11-02', generatedAt: '2026-11-02T10:00:00.000Z' });
    assert.deepEqual(snapshot.chokepoints.map((row) => row.id), SORTED_IDS);
    const hormuz = rowById(snapshot, 'hormuz_strait');
    assert.equal(hormuz.flow_ratio, 0.303);
    assert.equal(hormuz.flow_source, 'portwatch-dwt');
    assert.equal(hormuz.transit_data_available, true);
    assert.equal(snapshot.chokepoints.filter((row) => row.flow_ratio !== null).length, 7);
    for (const row of snapshot.chokepoints) assert.deepEqual(Object.keys(row), ROW_NAMES);
  });

  it('maps FLOW_SOURCE_UNSPECIFIED to null', () => {
    const cp = minimalChokepoint({
      flowEstimate: { flowRatio: 0.5, disrupted: false, source: 'FLOW_SOURCE_UNSPECIFIED' },
    });
    const [row] = buildSnapshot(minimalResponse([cp]), OPTIONS).chokepoints;
    assert.equal(row.flow_ratio, 0.5);
    assert.equal(row.flow_disrupted, false);
    assert.equal(row.flow_source, null);
  });
});

describe('open data chokepoint withheld fields', () => {
  it('never serializes a withheld API field that the capture carried', () => {
    const snapshot = buildSnapshot(fixtureBody, OPTIONS);
    const serialized = JSON.stringify(snapshot);
    const input = JSON.stringify(fixtureBody);
    for (const needle of [
      'incidentCount7d',
      'disruptionPct',
      'riskLevel',
      'baselineMbd',
      'currentMbd',
      'hazardAlert',
      'riskSummary',
      'riskReportAction',
      '"history"',
      'description',
      'HORMUZ-26',
    ]) {
      assert.equal(input.includes(needle), true, `capture carries ${needle}`);
      assert.equal(serialized.includes(needle), false, `snapshot omits ${needle}`);
    }
    assert.equal(serialized.includes('"baseline'), false);
    const suez = rowById(snapshot, 'suez');
    assert.equal(Object.values(suez).includes(7.6), false, 'suez baselineMbd 7.6 is not republished');
    assert.equal(Object.values(suez).includes(7.5), false, 'suez currentMbd 7.5 is not republished');
    for (const row of snapshot.chokepoints) assert.deepEqual(Object.keys(row), ROW_NAMES);
  });

  it('keeps every WITHHELD_FIELDS leaf out of the rows', () => {
    const rows = JSON.stringify(buildSnapshot(liveBody, { snapshotDate: '2026-11-02', generatedAt: '2026-11-02T10:00:00.000Z' }).chokepoints);
    const input = JSON.stringify(liveBody);
    const leaves = WITHHELD_FIELDS.map((field) => field.api_field.split('.').at(-1));
    assert.deepEqual(leaves, [
      'incidentCount7d',
      'disruptionPct',
      'riskLevel',
      'baselineMbd',
      'currentMbd',
      'hazardAlertLevel',
      'hazardAlertName',
      'history',
      'officialLatestTotal',
      'officialAvg7d',
      'baselineAvgDaily',
      'officialLatestDate',
      'baselineFrom',
      'baselineTo',
      'riskSummary',
      'riskReportAction',
      'description',
      'affectedRoutes',
      'directions',
      'directionalDwt',
    ]);
    for (const leaf of leaves) {
      assert.equal(input.includes(`"${leaf}"`), true, `capture carries ${leaf}`);
      assert.equal(rows.includes(`"${leaf}"`), false, `rows omit ${leaf}`);
    }
  });

  it('accounts for every field the live endpoint serves, as consumed or withheld', () => {
    const leafPaths = (cp) =>
      Object.entries(cp).flatMap(([key, value]) =>
        (key === 'transitSummary' || key === 'flowEstimate') && value && typeof value === 'object'
          ? Object.keys(value).map((inner) => `${key}.${inner}`)
          : [key],
      );
    const served = [...new Set(liveBody.chokepoints.flatMap(leafPaths))].sort();
    const withheld = WITHHELD_FIELDS.map((field) => field.api_field);
    assert.deepEqual(CONSUMED_FIELDS.filter((field) => withheld.includes(field)), []);
    assert.deepEqual(served, [...CONSUMED_FIELDS, ...withheld].sort());
    assert.ok(served.includes('transitSummary.officialAvg7d'), 'the capture carries the optional 7-day mean on at least one chokepoint');
  });
});

describe('open data chokepoint CSV', () => {
  it('writes the header and a hormuz row in column order', () => {
    const csv = toCsv(buildSnapshot(fixtureBody, OPTIONS));
    const lines = csv.split('\n');
    assert.equal(
      lines[0],
      'snapshot_date,id,name,lat,lon,status,disruption_score,war_risk_tier,congestion_level,active_warnings,ais_disruptions,navigational_warnings_available,ais_snapshot_available,transit_data_available,transit_today_counts_available,transit_today_total,transit_today_tanker,transit_today_cargo,transit_today_other,transit_wow_change_pct,flow_ratio,flow_disrupted,flow_source',
    );
    assert.equal(
      lines.find((line) => line.includes(',hormuz_strait,')),
      '2026-09-10,hormuz_strait,Strait of Hormuz,26.56,56.25,red,70,war_zone,normal,0,0,true,true,true,false,,,,,-26.7,0.122,true,portwatch-dwt',
    );
    assert.equal(csv.endsWith('\n'), true);
    assert.equal(csv.trimEnd().split('\n').length, 14);
  });

  it('quotes cells containing a comma or a double quote', () => {
    const snapshot = buildSnapshot(
      minimalResponse([
        minimalChokepoint({ id: 'a_strait', name: 'Strait, Test' }),
        minimalChokepoint({ id: 'b_gate', name: 'The "Gate"' }),
      ]),
      OPTIONS,
    );
    assert.deepEqual(toCsv(snapshot).split('\n').slice(1), [
      '2026-09-10,a_strait,"Strait, Test",1,2,green,0,unspecified,,0,0,false,false,false,false,,,,,,,,',
      '2026-09-10,b_gate,"The ""Gate""",1,2,green,0,unspecified,,0,0,false,false,false,false,,,,,,,,',
      '',
    ]);
  });
});

describe('open data chokepoint fail-closed input', () => {
  it('refuses an empty chokepoint list', () => {
    assert.throws(
      () => buildSnapshot({ chokepoints: [], fetchedAt: '', upstreamUnavailable: true }, OPTIONS),
      /no chokepoints; refusing to publish an empty snapshot/,
    );
  });

  it('refuses a snapshot date that is not a real calendar day', () => {
    for (const snapshotDate of ['2026/09/10', '2026-99-99', '2026-02-30', '2026-9-1', undefined]) {
      assert.throws(
        () => buildSnapshot(fixtureBody, { snapshotDate, generatedAt: OPTIONS.generatedAt }),
        new RegExp(`snapshotDate must be a YYYY-MM-DD calendar date, got ${JSON.stringify(snapshotDate) ?? 'undefined'}`.replace(/[/]/g, '\\/')),
      );
    }
  });

  it('refuses a snapshot date after the generation day, so latest cannot be pinned to the future', () => {
    assert.throws(
      () => buildSnapshot(fixtureBody, { snapshotDate: '2026-09-11', generatedAt: '2026-09-10T23:59:59.000Z' }),
      /snapshotDate 2026-09-11 is after the generation day 2026-09-10; refusing to pin latest to a future date/,
    );
    assert.equal(buildSnapshot(fixtureBody, { snapshotDate: '2026-09-11', generatedAt: '2026-09-11T00:00:00.000Z' }).snapshot_date, '2026-09-11');
    assert.equal(buildSnapshot(fixtureBody, { snapshotDate: '2026-09-10', generatedAt: '2026-09-11T00:00:00.000Z' }).snapshot_date, '2026-09-10');
  });

  it('refuses a row that would violate the published schema', () => {
    assert.throws(
      () => buildSnapshot(minimalResponse([minimalChokepoint({ status: 'purple' })]), OPTIONS),
      /chokepoint test_strait: status has unexpected value "purple"/,
    );
    assert.throws(
      () => buildSnapshot(minimalResponse([minimalChokepoint({ disruptionScore: 101 })]), OPTIONS),
      /chokepoint test_strait: disruption_score has unexpected value 101/,
    );
    assert.throws(
      () => buildSnapshot(minimalResponse([minimalChokepoint({ name: '' })]), OPTIONS),
      /chokepoint test_strait: name is missing/,
    );
    const flow = { flowRatio: 1.6, disrupted: false, source: 'portwatch-dwt' };
    assert.throws(
      () => buildSnapshot(minimalResponse([minimalChokepoint({ flowEstimate: flow })]), OPTIONS),
      /chokepoint test_strait: flow_ratio has unexpected value 1\.6/,
    );
    assert.equal(
      buildSnapshot(minimalResponse([minimalChokepoint({ flowEstimate: { ...flow, flowRatio: 1.5 } })]), OPTIONS).chokepoints[0].flow_ratio,
      1.5,
    );
  });
});

describe('open data chokepoint files', () => {
  it('writes dated, latest, schema, and index files and moves latest forward only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'open-data-chokepoints-'));
    try {
      const first = buildSnapshot(fixtureBody, OPTIONS);
      assert.deepEqual(await writeSnapshotFiles(dir, first), [
        join(dir, '2026-09-10.json'),
        join(dir, '2026-09-10.csv'),
        join(dir, 'latest.json'),
        join(dir, 'latest.csv'),
        join(dir, 'schema.json'),
        join(dir, 'index.json'),
      ]);
      assert.deepEqual((await readdir(dir)).sort(), [
        '2026-09-10.csv',
        '2026-09-10.json',
        'index.json',
        'latest.csv',
        'latest.json',
        'schema.json',
      ]);
      const dated = await readFile(join(dir, '2026-09-10.json'), 'utf8');
      assert.equal(await readFile(join(dir, 'latest.json'), 'utf8'), dated);
      assert.equal(dated, `${JSON.stringify(first, null, 2)}\n`);
      assert.equal(await readFile(join(dir, 'latest.csv'), 'utf8'), await readFile(join(dir, '2026-09-10.csv'), 'utf8'));
      assert.deepEqual(JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')), {
        schema_version: '1.0.0',
        dataset: 'worldmonitor-chokepoint-status',
        latest: '2026-09-10',
        dates: ['2026-09-10'],
      });

      await writeSnapshotFiles(dir, buildSnapshot(fixtureBody, { snapshotDate: '2026-09-11', generatedAt: '2026-09-11T07:00:00.000Z' }));
      const index = {
        schema_version: '1.0.0',
        dataset: 'worldmonitor-chokepoint-status',
        latest: '2026-09-11',
        dates: ['2026-09-10', '2026-09-11'],
      };
      assert.deepEqual(JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')), index);
      const newest = await readFile(join(dir, '2026-09-11.json'), 'utf8');
      assert.equal(await readFile(join(dir, 'latest.json'), 'utf8'), newest);

      const rerun = buildSnapshot(fixtureBody, { snapshotDate: '2026-09-11', generatedAt: '2026-09-11T09:00:00.000Z' });
      await writeSnapshotFiles(dir, rerun);
      assert.equal(await readFile(join(dir, 'latest.json'), 'utf8'), `${JSON.stringify(rerun, null, 2)}\n`);
      assert.equal(await readFile(join(dir, '2026-09-11.json'), 'utf8'), await readFile(join(dir, 'latest.json'), 'utf8'));

      assert.deepEqual(await writeSnapshotFiles(dir, buildSnapshot(fixtureBody, { ...OPTIONS, snapshotDate: '2026-09-09' })), [
        join(dir, '2026-09-09.json'),
        join(dir, '2026-09-09.csv'),
        join(dir, 'schema.json'),
        join(dir, 'index.json'),
      ]);
      assert.deepEqual(JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')), {
        ...index,
        dates: ['2026-09-09', '2026-09-10', '2026-09-11'],
      });
      assert.deepEqual((await readdir(dir)).filter((name) => name.includes('.tmp-')), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to rewrite a dated file once a later snapshot exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'open-data-chokepoints-'));
    try {
      const first = buildSnapshot(fixtureBody, OPTIONS);
      await writeSnapshotFiles(dir, first);
      await writeSnapshotFiles(dir, buildSnapshot(fixtureBody, { snapshotDate: '2026-09-11', generatedAt: '2026-09-11T07:00:00.000Z' }));
      const before = Object.fromEntries(
        await Promise.all((await readdir(dir)).sort().map(async (name) => [name, await readFile(join(dir, name), 'utf8')])),
      );

      const replay = buildSnapshot(
        { ...fixtureBody, chokepoints: fixtureBody.chokepoints.map((cp) => ({ ...cp, disruptionScore: 0, status: 'green' })) },
        { ...OPTIONS, generatedAt: '2026-09-12T00:00:00.000Z' },
      );
      await assert.rejects(
        () => writeSnapshotFiles(dir, replay),
        /refusing to rewrite 2026-09-10\.json: a later snapshot \(2026-09-11\) already exists/,
      );

      const after = Object.fromEntries(
        await Promise.all((await readdir(dir)).sort().map(async (name) => [name, await readFile(join(dir, name), 'utf8')])),
      );
      assert.deepEqual(after, before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('open data chokepoint CLI', () => {
  it('refuses --dry-run combined with a mode that writes to Redis', async () => {
    for (const mode of [['--publish-redis'], ['--import-dir', tmpdir()]]) {
      await assert.rejects(
        run(process.execPath, [GENERATOR, '--dry-run', '--input', fileURLToPath(FIXTURE_2026_11_02), ...mode], {
          env: { ...process.env, UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:9', UPSTASH_REDIS_REST_TOKEN: 'unused' },
        }),
        (err) => /--dry-run cannot be combined/.test(err.stderr),
      );
    }
  });

  it('saves the response it used and rebuilds the same snapshot from that file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'open-data-chokepoints-cli-'));
    try {
      const saved = join(dir, 'artifact', 'response.json');
      const out = join(dir, 'chokepoints');
      const dryRun = await run(process.execPath, [
        GENERATOR,
        '--input', fileURLToPath(FIXTURE_2026_11_02),
        '--save-input', saved,
        '--out', out,
        '--date', '2026-11-02',
        '--dry-run',
      ]);
      assert.match(dryRun.stdout, /^saved input /m);
      assert.match(dryRun.stdout, /would write .*2026-11-02\.json/);
      assert.deepEqual(JSON.parse(await readFile(saved, 'utf8')).body, liveBody);
      await assert.rejects(readdir(out), { code: 'ENOENT' });

      const build = await run(process.execPath, [GENERATOR, '--input', saved, '--out', out, '--date', '2026-11-02']);
      assert.match(build.stdout, /chokepoints=13 snapshot_date=2026-11-02/);
      const written = JSON.parse(await readFile(join(out, '2026-11-02.json'), 'utf8'));
      assert.equal(Number.isNaN(Date.parse(written.generated_at)), false);
      assert.deepEqual(written, buildSnapshot(liveBody, { snapshotDate: '2026-11-02', generatedAt: written.generated_at }));
      assert.deepEqual(JSON.parse(await readFile(join(out, 'index.json'), 'utf8')).dates, ['2026-11-02']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function stubFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: { ...init.headers }, body: init.body });
    const { status = 200, body } = responses.shift();
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { calls, fetchImpl };
}

describe('open data chokepoint fetch', () => {
  it('mints an anonymous wm-session and sends it as a cookie', async () => {
    const { calls, fetchImpl } = stubFetch([{ body: { token: 'tok123' } }, { body: fixtureBody }]);
    const result = await fetchChokepointStatus({ apiBase: 'https://example.test', userAgent: 'wm-open-data-test/1.0', fetchImpl });
    assert.equal(result, fixtureBody);
    assert.deepEqual(calls, [
      {
        url: 'https://example.test/api/wm-session',
        method: 'POST',
        headers: {
          'User-Agent': 'wm-open-data-test/1.0',
          Accept: 'application/json',
          Origin: 'https://example.test',
          Referer: 'https://example.test/',
          'Content-Type': 'application/json',
        },
        body: '{}',
      },
      {
        url: 'https://example.test/api/supply-chain/v1/get-chokepoint-status',
        method: 'GET',
        headers: {
          'User-Agent': 'wm-open-data-test/1.0',
          Accept: 'application/json',
          Origin: 'https://example.test',
          Referer: 'https://example.test/',
          Cookie: 'wm-session=tok123',
        },
        body: undefined,
      },
    ]);
  });

  it('sends the service key instead of minting a session', async () => {
    const { calls, fetchImpl } = stubFetch([{ body: fixtureBody }]);
    await fetchChokepointStatus({ apiBase: 'https://example.test/', apiKey: 'wm_abc', fetchImpl });
    assert.equal(calls.length, 1);
    const { 'User-Agent': userAgent, ...headers } = calls[0].headers;
    assert.equal(calls[0].url, 'https://example.test/api/supply-chain/v1/get-chokepoint-status');
    assert.match(userAgent, /^Mozilla\/5\.0 .* Chrome\/\d+/);
    assert.deepEqual(headers, {
      Accept: 'application/json',
      Origin: 'https://example.test',
      Referer: 'https://example.test/',
      'X-WorldMonitor-Key': 'wm_abc',
    });
  });

  it('retries a 5xx, gives up on a 4xx, and reports the status', async () => {
    const prior = process.env.WM_SEED_RETRY_DELAY_MS;
    process.env.WM_SEED_RETRY_DELAY_MS = '0';
    try {
      const serverError = stubFetch(Array.from({ length: 4 }, () => ({ status: 500, body: {} })));
      await assert.rejects(
        fetchChokepointStatus({ apiBase: 'https://example.test', apiKey: 'wm_abc', fetchImpl: serverError.fetchImpl }),
        /HTTP 500 for https:\/\/example\.test\/api\/supply-chain\/v1\/get-chokepoint-status/,
      );
      assert.equal(serverError.calls.length, 4);

      const forbidden = stubFetch([{ status: 403, body: {} }]);
      await assert.rejects(
        fetchChokepointStatus({ apiBase: 'https://example.test', apiKey: 'wm_abc', fetchImpl: forbidden.fetchImpl }),
        /HTTP 403/,
      );
      assert.equal(forbidden.calls.length, 1);

      const flakySession = stubFetch([
        { status: 503, body: {} },
        { status: 200, body: { token: 'tok_retry' } },
        { status: 200, body: fixtureBody },
      ]);
      assert.equal(await fetchChokepointStatus({ apiBase: 'https://example.test', fetchImpl: flakySession.fetchImpl }), fixtureBody);
      assert.deepEqual(
        flakySession.calls.map((call) => call.url),
        ['https://example.test/api/wm-session', 'https://example.test/api/wm-session', 'https://example.test/api/supply-chain/v1/get-chokepoint-status'],
      );
      assert.equal(flakySession.calls[2].headers.Cookie, 'wm-session=tok_retry');

      const deniedSession = stubFetch([{ status: 403, body: {} }]);
      await assert.rejects(
        fetchChokepointStatus({ apiBase: 'https://example.test', fetchImpl: deniedSession.fetchImpl }),
        /HTTP 403 for https:\/\/example\.test\/api\/wm-session/,
      );
      assert.equal(deniedSession.calls.length, 1);
    } finally {
      if (prior === undefined) delete process.env.WM_SEED_RETRY_DELAY_MS;
      else process.env.WM_SEED_RETRY_DELAY_MS = prior;
    }
  });
});

describe('open data chokepoint determinism', () => {
  it('produces identical output regardless of call count or input order', () => {
    const reversed = { ...fixtureBody, chokepoints: [...fixtureBody.chokepoints].reverse() };
    const fromReversed = buildSnapshot(reversed, OPTIONS);
    assert.deepEqual(
      fromReversed.chokepoints.map((row) => row.id),
      SORTED_IDS,
    );
    const serialized = JSON.stringify(buildSnapshot(fixtureBody, OPTIONS));
    assert.equal(JSON.stringify(buildSnapshot(fixtureBody, OPTIONS)), serialized);
    assert.equal(JSON.stringify(fromReversed), serialized);
    assert.equal(toCsv(fromReversed), toCsv(buildSnapshot(fixtureBody, OPTIONS)));
  });
});
