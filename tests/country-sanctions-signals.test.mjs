import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { gzipSync, gunzipSync } from 'node:zlib';
import { projectCountrySanctions, MAX_COUNTRY_SANCTIONS_BYTES } from '../shared/country-sanctions-signals.mjs';
import { mergeSanctionEntries, SEMA_SOURCE, SANCTIONS_SOURCE_VERSION, sanctionsListContentMeta } from '../scripts/_sema-sanctions.mjs';

const seed = readFileSync('scripts/seed-sanctions-pressure.mjs', 'utf8');
const pure = seed.replace(/^import\s.*$/gm, '').replace(/loadEnvFile\([^)]+\);/, '').split('async function fetchSource')[0];
const tail = seed.slice(seed.indexOf('async function fetchSanctionsPressure()')).replace(/^export /gm, '');
const now = Date.UTC(2026, 9, 6, 0);
const previousAt = now - 7 * 3600000;
const json = value => JSON.parse(JSON.stringify(value));
const record = (source, id, codes, effectiveAt = now - 100 * 86400000) => ({
  id: source === SEMA_SOURCE ? `sema-ca:iran:1-part-2:${id}` : `${source}:${id}`,
  name: `${source} designation ${id}`, sourceLists: [source], countryCodes: codes,
  countryNames: codes.map(code => `Country ${code}`), programs: ['TEST'],
  entityType: 'SANCTIONS_ENTITY_TYPE_ENTITY', effectiveAt: String(effectiveAt),
  isNew: false, _aliases: [], _identifiers: [],
});

async function produce({ previousState = { entryIds: ['SDN:1', 'CONSOLIDATED:1', 'sema-ca:iran:1-part-2:1'], observedAt: String(previousAt) },
  rows = { SDN: [record('SDN', 1, ['IR'], now), record('SDN', 2, ['IR', 'US'])],
    CONSOLIDATED: [record('CONSOLIDATED', 1, ['US'])], [SEMA_SOURCE]: [record(SEMA_SOURCE, 1, ['CA'])] },
  failures = [], stored = null, at = now, quarantined = [],
  publications = { SDN: now - 86400000, CONSOLIDATED: now - 86400000, [SEMA_SOURCE]: now - 2 * 86400000 } } = {}) {
  let options;
  const context = vm.createContext({
    console: { log() {}, warn() {} }, Buffer, gzipSync, gunzipSync,
    Date: class extends Date { static now() { return at; } },
    SEMA_SOURCE, SANCTIONS_SOURCE_VERSION, SANCTIONS_MAX_CONTENT_AGE_MIN: 43200, projectCountrySanctions,
    mergeSanctionEntries, sanctionsListContentMeta,
    verifySeedKey: async () => previousState,
    readSeedSnapshot: async () => stored,
    fetchSource: async ({ label }) => {
      if (failures.includes(label)) throw new Error('Fixture unavailable');
      return { entries: rows[label], datasetDate: publications[label] };
    },
    ingestSemaEntries: async () => failures.includes(SEMA_SOURCE)
      ? { records: [], error: 'SEMA_INGEST_FAILED' }
      : { records: rows[SEMA_SOURCE], quarantined, publishedAtMs: publications[SEMA_SOURCE], error: null },
    runSeed: (_d, _r, _k, _f, value) => { options = value; },
  });
  vm.runInContext(`${pure}\n${tail}`, context);
  const producerData = json(await context.fetchSanctionsPressure());
  const data = json(options.publishTransform(producerData));
  return { data, producerData, options, previousState };
}
const project = (data, code) => projectCountrySanctions(data, code, Number(data?.fetchedAt));

describe('active sanctions publication and read-time guards', () => {
  it('refuses contradictory, malformed and oversized metadata before canonical publication', async () => {
    const { producerData, options } = await produce();
    for (const mutate of [
      value => { value.datasetDate = value.fetchedAt; value.pressureMetadata.cohort.datasetDate = value.fetchedAt; },
      value => { value.totalCount = 99; value.pressureMetadata.cohort.totalCount = 99; },
      value => { value.countries[0].entryCount = -1; },
      value => { value.pressureMetadata.sourceHealth.SDN.privateIds = ['SDN:private']; },
      value => { value.pressureMetadata.comparison.kind = 'x'.repeat(5000); },
    ]) {
      const invalid = json(producerData);
      mutate(invalid);
      assert.throws(() => options.publishTransform(invalid), /Invalid canonical sanctions publication/);
    }
    assert.doesNotThrow(() => options.publishTransform(producerData));
  });

  it('keeps original clocks and attribution while refusing stale, future or invalid read clocks', async () => {
    const { data } = await produce();
    const fresh = projectCountrySanctions(data, 'IR', now + 12 * 3600000);
    assert.equal(fresh.sanctionsDesignations, 2);
    for (const readAt of [now - 1, now + 12 * 3600000 + 1, NaN, 0, Number.MAX_SAFE_INTEGER]) {
      const result = projectCountrySanctions(data, 'IR', readAt);
      assert.equal(result.state, 'unavailable');
      assert.equal(result.sanctionsDesignations, null);
      assert.equal(result.sanctionsNewDesignations, null);
    }
    const stale = projectCountrySanctions(data, 'IR', now + 12 * 3600000 + 1);
    assert.equal(stale.source.computationAt, data.fetchedAt);
    assert.equal(stale.source.datasetDate, data.datasetDate);
    assert.equal(stale.source.attribution, fresh.source.attribution);
    assert.equal(stale.source.sourceHealth.SDN.lastSuccessAt, now);
  });

  it('refuses counts when a retained contributing source expires after computation', async () => {
    const healthy = await produce();
    const retained = await produce({ failures: ['SDN'], stored: {
      version: 1, encoding: 'gzip-base64', data: gzipSync(JSON.stringify(healthy.producerData._sourceSnapshots)).toString('base64'),
    }, at: now + 47 * 3600000 });
    assert.equal(projectCountrySanctions(retained.data, 'IR', now + 48 * 3600000 - 1).state, 'observed');
    const expired = projectCountrySanctions(retained.data, 'IR', now + 48 * 3600000);
    assert.equal(expired.state, 'unavailable');
    assert.equal(expired.sanctionsDesignations, null);
    assert.equal(expired.source.sourceHealth.SDN.lastSuccessAt, now);
    assert.equal(expired.source.sourceHealth.SDN.retainedUntil, now + 48 * 3600000);
  });
});

describe('country sanctions producer projection', () => {
  it('publishes compact comparison and source evidence with the canonical cohort, not private state', async () => {
    const { data: canonical, producerData } = await produce();
    assert.equal(canonical._state.schemaVersion, 1);
    assert.equal(canonical._state.sourceVersion, SANCTIONS_SOURCE_VERSION);
    assert.deepEqual(canonical._state.cohort, {
      computationAt: String(now), datasetDate: canonical.datasetDate,
      totalCount: canonical.totalCount, newEntryCount: canonical.newEntryCount,
    });
    assert.equal(canonical._state.comparison.from, String(previousAt));
    assert.equal(canonical._state.sourceHealth.SDN.quarantinedCount, 0);
    assert.equal(JSON.stringify(canonical._state).includes('entryIds'), false);
    assert.equal(JSON.stringify(canonical._state).includes('"quarantined":'), false);
    assert.equal(canonical._state.entryIds, undefined);
    assert.equal(canonical.pressureMetadata, undefined);
    assert.equal(project(canonical, 'IR').sanctionsNewDesignations, 1);
    producerData._state.observedAt = String(now + 1);
    assert.equal(project(canonical, 'IR').comparison.from, String(previousAt));
  });

  it('rejects unbounded, noncanonical and out-of-Date-range clocks without generating a fallback', async () => {
    const { data, previousState } = await produce();
    for (const field of ['fetchedAt', 'datasetDate']) {
      for (const value of ['0'.repeat(200000) + data[field], '8640000000000001', '01', 'NaN']) {
        const invalid = json(data);
        invalid[field] = value;
        assert.equal(project(invalid, 'IR').state, 'unavailable', field);
      }
    }
    for (const observedAt of ['0'.repeat(200000) + String(previousAt), '8640000000000001', '01']) {
      const result = await produce({ previousState: { ...previousState, observedAt } });
      const projection = project(result.data, 'IR');
      assert.equal(projection.sanctionsNewDesignations, null);
      assert.equal(projection.comparison.kind, 'window-unavailable');
      assert.ok(Buffer.byteLength(JSON.stringify(projection)) <= 4096);
    }
  });

  it('does not infer quarantine zero from absent or malformed canonical evidence or an unpinned schema', async () => {
    const { data } = await produce();
    for (const change of [
      value => { delete value._state.sourceHealth.SDN.quarantinedCount; },
      value => { value._state.sourceHealth.SDN.quarantinedCount = '0'; },
      value => { value._state.sourceHealth.SDN.quarantinedCount = -1; },
      value => { value._state.sourceHealth.SDN.quarantined = []; },
      value => { value._state.schemaVersion = 2; },
      value => { value._state.sourceVersion = 'unknown'; },
      value => { value._state.cohort.computationAt = String(now + 1); },
      value => { value._state.comparison.from = '0'.repeat(200000) + String(previousAt); },
    ]) {
      const invalid = json(data);
      change(invalid);
      assert.equal(project(invalid, 'IR').state, 'unavailable');
    }
  });

  it('labels a zero with one unavailable source as partial display, not provider-wide absence', async () => {
    const { data } = await produce({ failures: ['SDN'] });
    const result = project(data, 'NZ');
    assert.equal(result.state, 'observed');
    assert.equal(result.partial, true);
    assert.equal(result.sanctionsDesignations, 0);
    assert.equal(result.sanctionsNewDesignations, 0);
    assert.equal(result.websiteCounts.scope, 'top-12-first-iso2-display-v1');
    assert.equal(result.websiteCounts.partial, true);
    assert.equal(result.source.sourceHealth.SDN.status, 'unavailable');
  });

  it('matches producer countries and its exact ID comparison interval, not effective-date recency', async () => {
    const { data, producerData } = await produce();
    const result = project(data, 'IR');
    assert.equal(result.sanctionsDesignations, 2);
    assert.equal(result.sanctionsNewDesignations, 1);
    assert.equal(data.entries.find(row => row.id === 'SDN:1').isNew, false);
    assert.equal(data.entries.find(row => row.id === 'SDN:2').isNew, true);
    assert.ok(Number(data.entries.find(row => row.id === 'SDN:2').effectiveAt) < previousAt);
    assert.deepEqual(result.comparison, {
      kind: 'id-set-difference', from: String(previousAt), to: String(now),
      rule: 'Current merged entry ID absent from previous producer state; effectiveAt is not a cutoff.',
    });
    assert.equal(producerData._state.observedAt, data.fetchedAt);
    assert.equal(result.source.datasetDate, data.datasetDate);
    assert.equal(result.source.sourceVersion, SANCTIONS_SOURCE_VERSION);
    assert.equal(project(data, 'US').sanctionsDesignations, 2);
  });

  it('uses uppercase first-match ISO2 semantics without name matching or accumulation', async () => {
    const { data } = await produce();
    data.countries = [
      { countryCode: 'ir', countryName: 'First', entryCount: 1, newEntryCount: 0, vesselCount: 0, aircraftCount: 0 },
      { countryCode: 'IR', countryName: 'Second', entryCount: 2, newEntryCount: 1, vesselCount: 0, aircraftCount: 0 },
      { countryCode: 'US', countryName: 'Iran', entryCount: 2, newEntryCount: 1, vesselCount: 0, aircraftCount: 0 },
    ];
    assert.equal(project(data, 'IR').sanctionsDesignations, 1);
    assert.equal(project(data, 'CA').sanctionsDesignations, 0);
    assert.throws(() => project(data, 'ir'), /normalized/);
    assert.throws(() => project(data, 'IRN'), /normalized/);
  });

  it('preserves top-12 display zero even when the full country index has a designation', async () => {
    const codes = ['AE', 'AU', 'BR', 'CA', 'CN', 'DE', 'FR', 'GB', 'IL', 'IN', 'IR', 'JP', 'US'];
    const rows = { SDN: codes.map((code, index) => record('SDN', index + 1, [code])),
      CONSOLIDATED: [record('CONSOLIDATED', 1, ['XX'])], [SEMA_SOURCE]: [record(SEMA_SOURCE, 1, ['XX'])] };
    const { data, producerData } = await produce({ rows });
    const omitted = codes.find(code => !data.countries.some(row => row.countryCode === code));
    assert.ok(omitted);
    assert.equal(producerData._countryCounts[omitted], 1);
    assert.equal(data.countries.length, 12);
    const result = project(data, omitted);
    assert.equal(result.sanctionsDesignations, 0);
    assert.equal(result.sanctionsNewDesignations, 0);
    assert.equal(result.countryRow, null);
    assert.match(result.source.scope, /not list-wide absence/);
  });

  it('keeps unknown comparison counts null in both outputs while preserving the native row', async () => {
    for (const previousState of [null, { entryIds: [] }, { entryIds: ['SDN:1'] }]) {
      const { data } = await produce({ previousState });
      const result = project(data, 'IR');
      assert.equal(result.sanctionsNewDesignations, null);
      assert.equal(result.comparison.from, null);
      assert.equal(result.websiteCounts.sanctionsNewDesignations, null);
      assert.equal(result.countryRow.newEntryCount, data.countries.find(row => row.countryCode === 'IR').newEntryCount);
      assert.equal(result.comparison.kind, previousState?.entryIds.length ? 'window-unavailable' : 'baseline-unavailable');
    }
  });

  it('returns a confirmed display zero only from an available snapshot with a known baseline', async () => {
    const { data } = await produce();
    const result = project(data, 'NZ');
    assert.equal(result.state, 'observed');
    assert.equal(result.sanctionsDesignations, 0);
    assert.equal(result.sanctionsNewDesignations, 0);
    assert.equal(project(null, 'NZ').sanctionsDesignations, null);
  });

  it('rejects the complete malformed or mixed-invalid saved ID population before comparing', async () => {
    for (const invalidId of [null, {}, 3, true, '', 'not-a-sanctions-id', 'SDN:x', 'CONSOLIDATED:-1',
      'sema-ca:unspecified:1-part-2:1', 'sema-ca:xx:1-part-2:1', 'sema-ca:iran:1-part-2:0']) {
      for (const entryIds of [[invalidId], ['SDN:1', invalidId], [invalidId, 'SDN:1']]) {
        const { data } = await produce({ previousState: { entryIds, observedAt: String(previousAt) } });
        for (const countryCode of ['IR', 'NZ']) {
          const result = project(data, countryCode);
          assert.equal(result.state, 'observed');
          assert.equal(result.sanctionsNewDesignations, null, JSON.stringify(entryIds));
          assert.equal(result.websiteCounts.sanctionsNewDesignations, null);
          assert.equal(result.comparison.kind, 'baseline-unavailable');
          assert.equal(result.comparison.from, null);
        }
      }
    }
  });

  it('accepts the full native ID forms without requiring prior IDs to remain in the current population', async () => {
    const entryIds = ['SDN:1', 'SDN:0', 'CONSOLIDATED:001', 'sema-ca:iran:1-part-2:900'];
    const { data } = await produce({ previousState: { entryIds, observedAt: String(previousAt) } });
    assert.equal(project(data, 'IR').sanctionsNewDesignations, 1);
    assert.equal(project(data, 'US').sanctionsNewDesignations, 2);
    assert.equal(project(data, 'CA').sanctionsNewDesignations, 1);
    assert.equal(project(data, 'IR').comparison.from, String(previousAt));
  });

  it('binds cohort vintage to the maximum actual selected source publication including unknown sources', async () => {
    for (const publications of [
      { SDN: now - 86400000, CONSOLIDATED: 0, [SEMA_SOURCE]: now - 2 * 86400000 },
      { SDN: 0, CONSOLIDATED: 0, [SEMA_SOURCE]: 0 },
    ]) {
      const { data } = await produce({ publications });
      assert.equal(data.datasetDate, String(Math.max(...Object.values(publications))));
      assert.equal(project(data, 'IR').state, 'observed');
      for (const datasetDate of [String(now), String(now - 3 * 86400000),
        publications.SDN ? '0' : String(now - 86400000)]) {
        const invalid = json(data);
        invalid.datasetDate = datasetDate;
        invalid._state.cohort.datasetDate = datasetDate;
        const result = project(invalid, 'IR');
        assert.equal(result.state, 'unavailable', datasetDate);
        assert.equal(result.sanctionsDesignations, null);
        assert.equal(result.sanctionsNewDesignations, null);
      }
    }
  });

  it('rejects a merged population above the available source population even when cohort and row agree', async () => {
    const { data } = await produce({ failures: ['CONSOLIDATED'] });
    const available = Object.values(data._state.sourceHealth).reduce((total, health) => total + health.recordCount, 0);
    for (const totalCount of [available + 1, 99, Number.MAX_SAFE_INTEGER]) {
      const invalid = json(data);
      invalid.totalCount = totalCount;
      invalid._state.cohort.totalCount = totalCount;
      invalid.countries.find(row => row.countryCode === 'IR').entryCount = totalCount;
      const result = project(invalid, 'IR');
      assert.equal(result.state, 'unavailable');
      assert.equal(result.sanctionsDesignations, null);
      assert.equal(result.sanctionsNewDesignations, null);
    }
  });

  it('allows real identity merges and overlapping country associations without population equality or country sums', async () => {
    const ofac = record('SDN', 1, ['IR', 'US']);
    const sema = record(SEMA_SOURCE, 1, ['CA']);
    ofac._identifiers = ['IMO:1234567'];
    sema._identifiers = ['IMO:1234567'];
    const { data } = await produce({
      rows: { SDN: [ofac, record('SDN', 2, ['IR', 'US'])],
        CONSOLIDATED: [record('CONSOLIDATED', 1, ['IR', 'US'])], [SEMA_SOURCE]: [sema] },
    });
    const available = Object.values(data._state.sourceHealth).reduce((total, health) => total + health.recordCount, 0);
    assert.equal(available, 4);
    assert.equal(data.totalCount, 3);
    assert.ok(data.countries.reduce((total, row) => total + row.entryCount, 0) > data.totalCount);
    for (const code of ['IR', 'US']) {
      const result = project(data, code);
      assert.equal(result.state, 'observed');
      assert.equal(result.sanctionsDesignations, 3);
      assert.equal(result.sanctionsNewDesignations, 1);
    }
    assert.ok(data.entries.find(row => row.id === 'SDN:1').sourceLists.includes(SEMA_SOURCE));
  });

  it('uses a safe population upper bound at and above the safe-integer limit', async () => {
    const { data } = await produce();
    const maximum = Number.MAX_SAFE_INTEGER;
    data.totalCount = maximum;
    data._state.cohort.totalCount = maximum;
    for (const counts of [[maximum - 2, 1, 1], [maximum, maximum, maximum]]) {
      for (const [index, health] of Object.values(data._state.sourceHealth).entries()) health.recordCount = counts[index];
      assert.equal(project(data, 'IR').state, 'observed');
    }
    const counts = [maximum - 3, 1, 1];
    for (const [index, health] of Object.values(data._state.sourceHealth).entries()) health.recordCount = counts[index];
    assert.equal(project(data, 'IR').state, 'unavailable');
  });

  it('retains provider clocks and reports partial source coverage without substituting retrieval time', async () => {
    const fresh = await produce();
    const stored = { version: 1, encoding: 'gzip-base64', data: gzipSync(JSON.stringify(fresh.producerData._sourceSnapshots)).toString('base64') };
    const { data } = await produce({ failures: ['SDN'], stored, at: now + 6 * 3600000, previousState: fresh.producerData._state });
    const result = project(data, 'IR');
    assert.equal(result.state, 'observed');
    assert.equal(result.partial, true);
    assert.equal(result.sanctionsDesignations, 2);
    assert.equal(result.sanctionsNewDesignations, 0);
    assert.equal(result.source.sourceHealth.SDN.lastSuccessAt, now);
    assert.equal(result.source.sourceHealth.SDN.retainedUntil, now + 48 * 3600000);
    assert.equal(result.source.computationAt, String(now + 6 * 3600000));
    assert.equal(result.comparison.from, String(now));
  });

  it('does not promote expired or absent sources to zero', async () => {
    const fresh = await produce();
    const stored = { version: 1, encoding: 'gzip-base64', data: gzipSync(JSON.stringify(fresh.producerData._sourceSnapshots)).toString('base64') };
    const { data } = await produce({ failures: ['SDN', 'CONSOLIDATED', SEMA_SOURCE], stored, at: now + 48 * 3600000 });
    const result = project(data, 'IR');
    assert.equal(result.state, 'unavailable');
    assert.equal(result.sanctionsDesignations, null);
    assert.equal(result.sanctionsNewDesignations, null);
    assert.equal(result.source.sourceHealth.SDN.status, 'unavailable');
    assert.equal(result.source.sourceHealth.SDN.lastSuccessAt, null);
    const legacy = json(fresh.data);
    delete legacy._state;
    assert.equal(project(legacy, 'IR').state, 'unavailable');
  });

  it('rejects malformed counts, over-cap rows, future clocks and extended retention', async () => {
    const { data, previousState } = await produce();
    const changes = [
      value => { value.countries[0].newEntryCount = -1; },
      value => { value.countries[0].entryCount = 1.5; },
      value => { value.countries = Array(13).fill(value.countries[0]); },
      value => { value.datasetDate = String(now + 1); },
      value => { value._state.sourceHealth.SDN.retainedUntil += 1; },
      value => { value._state.sourceHealth.SDN.lastSuccessAt = now + 1; },
    ];
    for (const change of changes) {
      const invalid = json(data);
      change(invalid);
      assert.equal(project(invalid, 'IR').state, 'unavailable');
    }
    const future = await produce({ previousState: { ...previousState, observedAt: String(now + 1) } });
    assert.equal(project(future.data, 'IR').sanctionsNewDesignations, null);
  });

  it('does not change the original producer snapshot', async () => {
    const { data } = await produce();
    const before = JSON.stringify(data);
    const result = project(data, 'IR');
    result.countryRow.entryCount = 99;
    result.source.sourceHealth.SDN.lastSuccessAt = 99;
    assert.equal(JSON.stringify(data), before);
  });

  it('bounds quarantine evidence and preserves unknown dataset vintage', async () => {
    const { data } = await produce({
      quarantined: Array(1000).fill({ id: 'fixture', reason: 'INVALID_IMO' }),
      publications: { SDN: 0, CONSOLIDATED: 0, [SEMA_SOURCE]: 0 },
    });
    assert.equal(data.datasetDate, '0');
    assert.ok(Object.values(data._state.sourceHealth).every(health => health.publishedAt === 0));
    const result = project(data, 'IR');
    assert.equal(result.state, 'observed');
    assert.equal(result.partial, true);
    assert.equal(result.source.datasetDate, '0');
    assert.equal(result.source.sourceHealth[SEMA_SOURCE].quarantinedCount, 1000);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= MAX_COUNTRY_SANCTIONS_BYTES);
  });

  it('excludes removed records and treats a reappearing ID according to the actual saved state', async () => {
    const fresh = await produce();
    const rows = { SDN: [record('SDN', 1, ['IR'])],
      CONSOLIDATED: [record('CONSOLIDATED', 1, ['US'])], [SEMA_SOURCE]: [record(SEMA_SOURCE, 1, ['CA'])] };
    const removed = await produce({ rows, previousState: fresh.producerData._state, at: now + 6 * 3600000 });
    const result = project(removed.data, 'IR');
    assert.equal(result.sanctionsDesignations, 1);
    assert.equal(result.sanctionsNewDesignations, 0);
    const reappeared = await produce({ previousState: removed.producerData._state, at: now + 12 * 3600000 });
    assert.equal(project(reappeared.data, 'IR').sanctionsNewDesignations, 1);
  });

  it('copies only the bounded country-pressure fields', async () => {
    const { data } = await produce();
    data.countries.find(row => row.countryCode === 'IR').extra = 'x'.repeat(100000);
    const result = project(data, 'IR');
    assert.equal(result.countryRow.extra, undefined);
    assert.ok(JSON.stringify(result).length < 4000);
  });

  it('bounds serialized UTF-8 including escaped names and maximal safe counts', async () => {
    const { data } = await produce();
    for (const name of ['界'.repeat(200), '\u0000'.repeat(200), '😀'.repeat(100)]) {
      const wide = json(data);
      const maximum = Number.MAX_SAFE_INTEGER;
      wide.totalCount = maximum;
      wide.newEntryCount = maximum;
      wide._state.cohort.totalCount = maximum;
      wide._state.cohort.newEntryCount = maximum;
      wide.countries = [{
        countryCode: 'IR', countryName: name, entryCount: maximum, newEntryCount: maximum,
        vesselCount: maximum, aircraftCount: maximum, privateExtension: 'x'.repeat(200000),
      }];
      for (const health of Object.values(wide._state.sourceHealth)) {
        health.recordCount = maximum;
        health.quarantinedCount = maximum;
      }
      const result = project(wide, 'IR');
      assert.equal(result.state, 'observed');
      assert.equal(result.partial, true);
      assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= MAX_COUNTRY_SANCTIONS_BYTES);
      assert.equal(result.countryRow.privateExtension, undefined);
      assert.equal(result.source.sourceHealth.SDN.quarantined, undefined);
    }
  });

  it('keeps retained legacy quarantine coverage unknown instead of a known zero', async () => {
    const fresh = await produce();
    const snapshots = json(fresh.producerData._sourceSnapshots);
    for (const snapshot of Object.values(snapshots)) delete snapshot.quarantinedCount;
    const stored = { version: 1, encoding: 'gzip-base64', data: gzipSync(JSON.stringify(snapshots)).toString('base64') };
    const retained = await produce({ failures: ['SDN', 'CONSOLIDATED', SEMA_SOURCE], stored,
      at: now + 6 * 3600000, previousState: fresh.producerData._state });
    const result = project(retained.data, 'IR');
    assert.equal(result.state, 'observed');
    assert.equal(result.partial, true);
    assert.equal(result.source.sourceHealth.SDN.quarantinedCount, null);
    assert.equal(result.source.sourceHealth.SDN.lastSuccessAt, now);
    assert.equal(result.source.sourceHealth.SDN.retainedUntil, now + 48 * 3600000);
  });
});
