import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

const {
  afterPublish,
  fetchGdeltBulkFiles,
  fetchMaterializedGdelt,
  GDELT_BULK_ARTICLES_KEY,
  GDELT_BULK_CONFLICT_KEY,
  GDELT_BULK_STATE_KEY,
  GDELT_BULK_UNREST_KEY,
  GDELT_INTEL_KEY,
  POSITIVE_EVENTS_BOOTSTRAP_KEY,
  POSITIVE_EVENTS_RPC_KEY,
  RUN_SEED_OPTS,
} = await import('../scripts/seed-gdelt-bulk-materializer.mjs');

function gkgRow({
  id = 'gkg-1',
  timestamp = '20260730120000',
  url = 'https://example.com/military',
  title = 'Military exercise expands',
  themes = 'MILITARY,1',
}) {
  const fields = Array.from({ length: 27 }, () => '');
  fields[0] = id;
  fields[1] = timestamp;
  fields[3] = 'example.com';
  fields[4] = url;
  fields[8] = themes;
  fields[10] = '1#Cairo, Egypt#EG#EG11#30.0444#31.2357#-290692';
  fields[15] = '-2.5,1,2,3';
  fields[26] = `<PAGE_TITLE>${title}</PAGE_TITLE>`;
  return fields.join('\t');
}

function exportRow({
  id = 'event-1',
  timestamp = '20260730120000',
  country = 'SU',
}) {
  const fields = Array.from({ length: 61 }, () => '');
  fields[0] = id;
  fields[25] = '1';
  fields[26] = '190';
  fields[28] = '19';
  fields[29] = '4';
  fields[53] = country;
  fields[59] = timestamp;
  fields[60] = `https://example.com/${id}`;
  return fields.join('\t');
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(filename, csv) {
  const name = Buffer.from(filename);
  const data = Buffer.from(csv);
  const checksum = crc32(data);
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt32LE(checksum, 14);
  localHeader.writeUInt32LE(data.length, 18);
  localHeader.writeUInt32LE(data.length, 22);
  localHeader.writeUInt16LE(name.length, 26);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt32LE(checksum, 16);
  centralHeader.writeUInt32LE(data.length, 20);
  centralHeader.writeUInt32LE(data.length, 24);
  centralHeader.writeUInt16LE(name.length, 28);

  const localFile = Buffer.concat([localHeader, name, data]);
  const centralDirectory = Buffer.concat([centralHeader, name]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localFile.length, 16);
  return Buffer.concat([localFile, centralDirectory, end]);
}

function bulkDescriptorLine(kind, timestamp, zip, { size = zip.length, md5 } = {}) {
  const filename = kind === 'gkg' ? 'gkg.csv' : 'export.CSV';
  return `${size} ${md5 ?? createHash('md5').update(zip).digest('hex')} `
    + `https://data.gdeltproject.org/gdeltv2/${timestamp}.${filename}.zip`;
}

function bulkFixture({
  gkgTimestamp = '20260730120000',
  exportTimestamp = '20260730120000',
  gkgZip = storedZip(`${gkgTimestamp}.gkg.csv`, gkgRow({ timestamp: gkgTimestamp })),
  exportZip = storedZip(`${exportTimestamp}.export.CSV`, exportRow({ timestamp: exportTimestamp })),
  gkgDescriptor = {},
  exportDescriptor = {},
} = {}) {
  const gkgLine = bulkDescriptorLine('gkg', gkgTimestamp, gkgZip, gkgDescriptor);
  const exportLine = bulkDescriptorLine('export', exportTimestamp, exportZip, exportDescriptor);
  const canonicalDownloadUrl = (line) => line.split(' ')[2].replace(
    'https://data.gdeltproject.org/',
    'https://storage.googleapis.com/data.gdeltproject.org/',
  );
  const files = new Map([
    [canonicalDownloadUrl(gkgLine), gkgZip],
    [canonicalDownloadUrl(exportLine), exportZip],
  ]);
  return { manifest: `${gkgLine}\n${exportLine}\n`, files };
}

function fakeBulkFetch(manifest, files, manifestStatus = 206) {
  let requestNumber = 0;
  return async (url) => {
    requestNumber += 1;
    const body = requestNumber === 1 ? Buffer.from(manifest) : files.get(String(url));
    assert.ok(body, `unexpected bulk request: ${url}`);
    return new Response(body, {
      status: requestNumber === 1 ? manifestStatus : 200,
      headers: { 'content-length': String(body.length) },
    });
  };
}

describe('seed-gdelt-bulk-materializer download boundaries', () => {
  it('downloads a matching current GKG and export cohort from valid stored ZIPs', async () => {
    const fixture = bulkFixture();
    const downloaded = await fetchGdeltBulkFiles({
      fetchImpl: fakeBulkFetch(fixture.manifest, fixture.files),
      nowMs: Date.parse('2026-07-30T12:05:00Z'),
    });

    assert.deepEqual(
      downloaded.map(({ descriptor }) => [descriptor.kind, descriptor.timestamp]),
      [['gkg', '20260730120000'], ['export', '20260730120000']],
    );
    assert.equal(downloaded.find(({ descriptor }) => descriptor.kind === 'gkg').records[0].id, 'gkg-1');
    assert.equal(downloaded.find(({ descriptor }) => descriptor.kind === 'export').events[0].id, 'gdelt-event-event-1');
  });

  it('requires a partial-content manifest response', async () => {
    const fixture = bulkFixture();
    await assert.rejects(
      fetchGdeltBulkFiles({
        fetchImpl: fakeBulkFetch(fixture.manifest, fixture.files, 200),
        nowMs: Date.parse('2026-07-30T12:05:00Z'),
      }),
      /expected HTTP 206, got 200/i,
    );
  });

  it('rejects ZIP size or checksum mismatches before parsing', async () => {
    const sizeMismatch = bulkFixture({
      gkgDescriptor: { size: 999_999 },
    });
    await assert.rejects(
      fetchGdeltBulkFiles({
        fetchImpl: fakeBulkFetch(sizeMismatch.manifest, sizeMismatch.files),
        nowMs: Date.parse('2026-07-30T12:05:00Z'),
      }),
      /gkg download size mismatch/i,
    );

    const checksumMismatch = bulkFixture({
      exportDescriptor: { md5: '00000000000000000000000000000000' },
    });
    await assert.rejects(
      fetchGdeltBulkFiles({
        fetchImpl: fakeBulkFetch(checksumMismatch.manifest, checksumMismatch.files),
        nowMs: Date.parse('2026-07-30T12:05:00Z'),
      }),
      /export checksum mismatch/i,
    );
  });

  it('rejects an asymmetric GKG and export cohort', async () => {
    const fixture = bulkFixture({ exportTimestamp: '20260730114500' });
    await assert.rejects(
      fetchGdeltBulkFiles({
        fetchImpl: fakeBulkFetch(fixture.manifest, fixture.files),
        nowMs: Date.parse('2026-07-30T12:05:00Z'),
      }),
      /symmetric GKG.*export cohort/i,
    );
  });

  it('rejects an interior per-kind manifest gap before downloading the cohort', async () => {
    const descriptors = [
      ['gkg', '20260730113000'],
      ['export', '20260730113000'],
      ['gkg', '20260730114500'],
      ['gkg', '20260730120000'],
      ['export', '20260730120000'],
    ];
    const manifest = descriptors.map(([kind, timestamp]) => {
      const filename = kind === 'gkg' ? 'gkg.csv' : 'export.CSV';
      const csv = kind === 'gkg'
        ? gkgRow({ id: `gkg-${timestamp}`, timestamp })
        : exportRow({ id: `export-${timestamp}`, timestamp });
      const zip = storedZip(`${timestamp}.${filename}`, csv);
      return bulkDescriptorLine(kind, timestamp, zip);
    }).join('\n');
    let requestCount = 0;

    await assert.rejects(
      fetchGdeltBulkFiles({
        fetchImpl: async () => {
          requestCount += 1;
          assert.equal(requestCount, 1, 'cohort validation must run before file downloads');
          return new Response(Buffer.from(manifest), {
            status: 206,
            headers: { 'content-length': String(Buffer.byteLength(manifest)) },
          });
        },
        nowMs: Date.parse('2026-07-30T12:05:00Z'),
      }),
      /non-contiguous export cohort.*20260730113000.*20260730120000/i,
    );
    assert.equal(requestCount, 1);
  });
});

const TOPICS = ['military', 'cyber', 'nuclear', 'sanctions', 'intelligence', 'maritime'];

function materializationFiles({
  timestamp = '20260730120000',
  records,
  events,
} = {}) {
  return [
    {
      descriptor: { kind: 'gkg', timestamp },
      ...(records ? { records } : { csv: gkgRow({ timestamp }) }),
    },
    {
      descriptor: { kind: 'export', timestamp },
      ...(events ? { events } : { csv: exportRow({ timestamp }) }),
    },
  ];
}

function publicationData() {
  return {
    fetchedAt: '2026-07-30T12:05:00.000Z',
    _timelines: Object.fromEntries(
      TOPICS.map((topic) => [topic, {
        tone: [{ date: '2026-07-30T11:45:00.000Z', value: -1 }],
        vol: [{ date: '2026-07-30T12:00:00.000Z', value: 2 }],
        toneFetchedAt: '2026-07-30T11:45:00.000Z',
        volFetchedAt: '2026-07-30T12:00:00.000Z',
        fetchedAt: '2026-07-30T12:00:00.000Z',
      }]),
    ),
    _conflict: { events: [{ id: 'c1' }] },
    _unrest: { events: [{ id: 'u1' }] },
    _positive: { events: [{ name: 'p1' }] },
    _reference: { articles: [{ title: 'r1' }] },
    _state: { cursor: { gkg: '20260730120000', export: '20260730120000' } },
  };
}

describe('seed-gdelt-bulk-materializer fetch integration', () => {
  it('advances per-kind cursors and merges the rolling conflict window', async () => {
    const previousState = {
      cursor: { gkg: '20260730114500', export: '20260730114500' },
      recentGkgBatches: [{
        timestamp: '20260730114500',
        records: [{
          id: 'prior-geo',
          date: '2026-07-30T11:45:00.000Z',
          url: 'https://example.com/prior-geo',
          source: 'example.com',
          title: 'Prior military protest',
          image: '',
          tone: -9,
          themes: ['PROTEST', 'MILITARY'],
          locations: [{
            name: 'Cairo, Egypt',
            countryCode: 'EG',
            latitude: 30.0444,
            longitude: 31.2357,
          }],
        }],
      }],
      timelines: {
        military: {
          tone: [{ date: '2026-07-30T11:45:00.000Z', value: -7 }],
          vol: [{ date: '2026-07-30T11:45:00.000Z', value: 9 }],
        },
      },
      reference: { articles: [] },
      conflict: {
        source: 'gdelt-bulk',
        events: [{
          id: 'gdelt-event-prior',
          country: 'Ukraine',
          gdeltAddedAt: Date.parse('2026-07-30T11:45:00Z'),
          occurredAt: Date.parse('2026-07-30T11:45:00Z'),
        }],
        pagination: {
          exportTimestamp: '20260730114500',
          rollingWindowStartedAt: Date.parse('2026-07-30T11:30:00Z'),
        },
      },
    };
    const reads = [];
    const result = await fetchMaterializedGdelt({
      _now: () => Date.parse('2026-07-30T12:05:00Z'),
      _readSnapshot: async (key) => {
        reads.push(key);
        if (key === GDELT_INTEL_KEY) return null;
        if (key === GDELT_BULK_STATE_KEY) return previousState;
        throw new Error(`unexpected key ${key}`);
      },
      _fetchFiles: async ({ afterTimestamp }) => {
        assert.deepEqual(afterTimestamp, previousState.cursor);
        return [
          {
            descriptor: { kind: 'gkg', timestamp: '20260730120000' },
            csv: gkgRow({}),
          },
          {
            descriptor: { kind: 'export', timestamp: '20260730120000' },
            csv: exportRow({}),
          },
        ];
      },
    });

    assert.deepEqual(reads.sort(), [GDELT_BULK_STATE_KEY, GDELT_INTEL_KEY].sort());
    assert.deepEqual(result._state.cursor, {
      gkg: '20260730120000',
      export: '20260730120000',
    });
    assert.deepEqual(
      result._state.recentGkgBatches.flatMap((batch) =>
        batch.records.map((record) => record.id)),
      ['prior-geo'],
      'topic-only current records stay out while prior geo evidence remains',
    );
    assert.deepEqual(result._timelines.military.tone, [
      { date: '2026-07-30T11:45:00.000Z', value: -7 },
      { date: '2026-07-30T12:00:00.000Z', value: -2.5 },
    ]);
    assert.deepEqual(
      result._conflict.events.map((event) => event.id).sort(),
      ['gdelt-event-event-1', 'gdelt-event-prior'],
    );
    assert.equal(result.topics.find((topic) => topic.id === 'military').articles.length, 1);
  });

  it('fails closed unless both feeds are current and GKG has usable records', async () => {
    const baseDeps = {
      _now: () => Date.parse('2026-07-30T12:05:00Z'),
      _readSnapshot: async () => null,
    };
    await assert.rejects(
      fetchMaterializedGdelt({
        ...baseDeps,
        _fetchFiles: async () => materializationFiles().filter(
          ({ descriptor }) => descriptor.kind === 'gkg',
        ),
      }),
      /no current export snapshot/i,
    );
    await assert.rejects(
      fetchMaterializedGdelt({
        ...baseDeps,
        _fetchFiles: async () => materializationFiles().filter(
          ({ descriptor }) => descriptor.kind === 'export',
        ),
      }),
      /no current GKG snapshot/i,
    );
    await assert.rejects(
      fetchMaterializedGdelt({
        ...baseDeps,
        _fetchFiles: async () => materializationFiles({ records: [] }),
      }),
      /no usable GKG records/i,
    );
    await assert.rejects(
      fetchMaterializedGdelt({
        ...baseDeps,
        _fetchFiles: async () => [
          materializationFiles()[0],
          {
            descriptor: { kind: 'export', timestamp: '20260730094500' },
            csv: exportRow({ timestamp: '20260730094500' }),
          },
        ],
      }),
      /export snapshot.*freshness window/i,
    );
    await assert.rejects(
      fetchMaterializedGdelt({
        ...baseDeps,
        _fetchFiles: async () => [
          {
            descriptor: { kind: 'gkg', timestamp: '20260730094500' },
            csv: gkgRow({ timestamp: '20260730094500' }),
          },
          materializationFiles()[1],
        ],
      }),
      /GKG snapshot.*freshness window/i,
    );
  });

  it('fails closed when fresh GKG records do not match any materialized topic', async () => {
    const cachedArticle = {
      title: 'Cached military report',
      url: 'https://example.com/cached-military',
      source: 'example.com',
      date: '2026-07-30T11:45:00.000Z',
      image: '',
      language: 'English',
      tone: -2,
    };

    await assert.rejects(
      fetchMaterializedGdelt({
        _now: () => Date.parse('2026-07-30T12:05:00Z'),
        _readSnapshot: async (key) => {
          if (key === GDELT_INTEL_KEY) {
            return {
              topics: [{
                id: 'military',
                fetchedAt: cachedArticle.date,
                articles: [cachedArticle],
              }],
            };
          }
          return null;
        },
        _fetchFiles: async () => materializationFiles({
          records: [{
            id: 'fresh-non-topic',
            date: '2026-07-30T12:00:00.000Z',
            url: 'https://example.com/local-protest',
            source: 'example.com',
            title: 'Local demonstration continues',
            image: '',
            tone: -1,
            themes: ['PROTEST'],
            locations: [],
          }],
        }),
      }),
      /no fresh GDELT topic matches/i,
    );
  });

  it('imports all legacy timelines only when materializer state is absent', async () => {
    const reads = [];
    const legacyTonePoint = { date: '2026-07-28T10:00:00.000Z', value: -3 };
    const legacyVolumePoint = { date: '2026-07-30T11:45:00.000Z', value: 7 };
    const result = await fetchMaterializedGdelt({
      _now: () => Date.parse('2026-07-30T12:05:00Z'),
      _readSnapshot: async (key) => {
        reads.push(key);
        if (key === GDELT_INTEL_KEY || key === GDELT_BULK_STATE_KEY) return null;
        const tone = key.startsWith('gdelt:intel:tone:');
        return {
          data: [tone ? legacyTonePoint : legacyVolumePoint],
          fetchedAt: tone ? legacyTonePoint.date : legacyVolumePoint.date,
        };
      },
      _fetchFiles: async () => materializationFiles(),
    });

    const legacyKeys = TOPICS.flatMap((topic) => [
      `gdelt:intel:tone:${topic}`,
      `gdelt:intel:vol:${topic}`,
    ]);
    assert.deepEqual(
      reads.filter((key) => key.startsWith('gdelt:intel:tone:')
        || key.startsWith('gdelt:intel:vol:')).sort(),
      legacyKeys.sort(),
    );
    for (const topic of TOPICS) {
      assert.ok(
        result._timelines[topic].tone.some(({ date }) => date === legacyTonePoint.date),
        `missing legacy tone history for ${topic}`,
      );
      assert.ok(
        result._timelines[topic].vol.some(({ date }) => date === legacyVolumePoint.date),
        `missing legacy volume history for ${topic}`,
      );
    }
    assert.equal(result._timelines.cyber.toneFetchedAt, legacyTonePoint.date);
    assert.equal(result._timelines.cyber.volFetchedAt, legacyVolumePoint.date);
    assert.equal(
      result._timelines.cyber.fetchedAt,
      legacyVolumePoint.date,
      'compatibility freshness is allowed to reflect the newest series only',
    );
  });

  it('resets and persists continuous coverage after a capped-descriptor gap', async () => {
    const previousState = {
      cursor: { gkg: '20260730100000', export: '20260730100000' },
      conflict: {
        source: 'gdelt-bulk',
        events: [{
          id: 'gdelt-event-prior',
          country: 'Ukraine',
          gdeltAddedAt: Date.parse('2026-07-30T10:00:00Z'),
          occurredAt: Date.parse('2026-07-30T10:00:00Z'),
        }],
        pagination: {
          exportTimestamp: '20260730100000',
          rollingWindowStartedAt: Date.parse('2026-07-29T11:00:00Z'),
          rollingWindowComplete: true,
        },
      },
    };
    const first = await fetchMaterializedGdelt({
      _now: () => Date.parse('2026-07-30T11:05:00Z'),
      _readSnapshot: async (key) => key === GDELT_BULK_STATE_KEY ? previousState : null,
      _fetchFiles: async () => materializationFiles({ timestamp: '20260730110000' }),
    });

    assert.equal(first._conflict.pagination.rollingWindowComplete, false);
    assert.equal(
      first._conflict.pagination.rollingWindowStartedAt,
      Date.parse('2026-07-30T11:00:00Z'),
    );
    assert.deepEqual(first._state.coverage.export.lastGap, {
      previousCursor: '20260730100000',
      resumedAt: '20260730110000',
      gapMs: 60 * 60 * 1000,
      detectedAt: Date.parse('2026-07-30T11:05:00Z'),
    });
    assert.equal(first._state.coverage.export.continuousSince, '20260730110000');
    assert.equal(first._state.coverage.gkg.continuousSince, '20260730110000');
    assert.equal(first._state.coverage.gkg.lastGap.gapMs, 60 * 60 * 1000);

    const second = await fetchMaterializedGdelt({
      _now: () => Date.parse('2026-07-30T11:20:00Z'),
      _readSnapshot: async (key) => key === GDELT_BULK_STATE_KEY ? first._state : null,
      _fetchFiles: async () => materializationFiles({ timestamp: '20260730111500' }),
    });
    assert.equal(second._conflict.pagination.rollingWindowComplete, false);
    assert.equal(second._state.coverage.export.continuousSince, '20260730110000');
    assert.deepEqual(second._state.coverage.export.lastGap, first._state.coverage.export.lastGap);
  });

  it('compacts geo records before aggregation and state persistence', async () => {
    const location = (name, latitude, longitude) => ({
      name,
      countryCode: 'EG',
      latitude,
      longitude,
    });
    const records = [
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `excluded-oldest-${index}`,
        date: '2026-07-30T12:00:00.000Z',
        url: `https://example.com/excluded-oldest-${index}`,
        source: 'example.com',
        title: 'Protest excluded',
        image: '',
        tone: -10,
        themes: ['PROTEST', 'MILITARY'],
        locations: [location('Cairo, Egypt', 30.0444, 31.2357)],
      })),
      ...Array.from({ length: 5_000 }, (_, index) => ({
        id: `kept-${index}`,
        date: '2026-07-30T12:00:00.000Z',
        url: `https://example.com/kept-${index}`,
        source: 'example.com',
        title: 'Protest kept',
        image: '',
        tone: -2,
        themes: ['PROTEST', 'MILITARY'],
        locations: [location('Alexandria, Egypt', 31.2001, 29.9187)],
      })),
    ];
    const result = await fetchMaterializedGdelt({
      _now: () => Date.parse('2026-07-30T12:05:00Z'),
      _readSnapshot: async () => ({ cursor: {} }),
      _fetchFiles: async () => materializationFiles({ records }),
    });

    assert.equal(
      result._state.recentGkgBatches.flatMap(({ records: batchRecords }) => batchRecords).length,
      5_000,
    );
    assert.equal(result._unrest.events.length, 1);
    assert.equal(result._unrest.events[0].city, 'Alexandria');
    assert.equal(result._unrest.events[0].tone, -2);
  });

  it('publishes only the established intel shape to the canonical key', () => {
    const raw = {
      topics: [{ id: 'military', articles: [], fetchedAt: 'x' }],
      fetchedAt: 'x',
      _state: { cursor: {} },
      _conflict: { events: [] },
    };
    assert.deepEqual(RUN_SEED_OPTS.publishTransform(raw), {
      topics: raw.topics,
      fetchedAt: 'x',
    });
  });
});

describe('seed-gdelt-bulk-materializer publication cohort', () => {
  it('writes every derived key and advances state last', async () => {
    const writes = [];
    const data = publicationData();

    const outcome = await afterPublish(data, undefined, {
      _writeExtraKey: async (key, value, ttl) => {
        writes.push({ type: 'data', key, value, ttl });
      },
      _writeExtraKeyWithMeta: async (...args) => {
        writes.push({ type: 'meta', key: args[0], args });
      },
    });

    assert.deepEqual(outcome, { completionState: 'OK' });
    assert.equal(writes.filter(({ key }) => key.startsWith('gdelt:intel:')).length, 12);
    for (const key of [
      GDELT_BULK_CONFLICT_KEY,
      GDELT_BULK_UNREST_KEY,
      GDELT_BULK_ARTICLES_KEY,
      POSITIVE_EVENTS_RPC_KEY,
      POSITIVE_EVENTS_BOOTSTRAP_KEY,
      GDELT_BULK_STATE_KEY,
    ]) {
      assert.ok(writes.some((write) => write.key === key), `missing write for ${key}`);
    }
    assert.equal(writes.at(-1).key, GDELT_BULK_STATE_KEY);
    assert.equal(
      writes.find(({ key }) => key === POSITIVE_EVENTS_RPC_KEY).type,
      'meta',
    );
    assert.equal(
      writes.find(({ key }) => key === 'gdelt:intel:tone:military').value.fetchedAt,
      data._timelines.military.toneFetchedAt,
    );
    assert.equal(
      writes.find(({ key }) => key === 'gdelt:intel:vol:military').value.fetchedAt,
      data._timelines.military.volFetchedAt,
    );
  });

  it('preserves every derived key with its configured freshness TTL', () => {
    const expected = [
      ...TOPICS.flatMap((topic) => [
        { key: `gdelt:intel:tone:${topic}`, ttlSeconds: 7 * 86_400 },
        { key: `gdelt:intel:vol:${topic}`, ttlSeconds: 7 * 86_400 },
      ]),
      { key: GDELT_BULK_CONFLICT_KEY, ttlSeconds: 6 * 60 * 60 },
      { key: GDELT_BULK_UNREST_KEY, ttlSeconds: 4.5 * 60 * 60 },
      { key: GDELT_BULK_ARTICLES_KEY, ttlSeconds: 2 * 86_400 },
      { key: POSITIVE_EVENTS_RPC_KEY, ttlSeconds: 3 * 60 * 60 },
      { key: POSITIVE_EVENTS_BOOTSTRAP_KEY, ttlSeconds: 3 * 60 * 60 },
      { key: 'seed-meta:positive-events:geo', ttlSeconds: 7 * 86_400 },
      { key: GDELT_BULK_STATE_KEY, ttlSeconds: 14 * 86_400 },
    ];
    assert.deepEqual(RUN_SEED_OPTS.preserveKeyTtls, expected);
  });

  it('settles all output writes and rejects false metadata writes before state', async () => {
    const data = publicationData();
    let releaseSlowWrite;
    let slowWriteSettled = false;
    let stateWritten = false;
    const slowWrite = new Promise((resolve) => {
      releaseSlowWrite = () => {
        slowWriteSettled = true;
        resolve();
      };
    });
    const publish = afterPublish(data, undefined, {
      _writeExtraKey: async (key) => {
        if (key === 'gdelt:intel:tone:military') return slowWrite;
        if (key === GDELT_BULK_STATE_KEY) stateWritten = true;
        return undefined;
      },
      _writeExtraKeyWithMeta: async () => false,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stateWritten, false);
    assert.equal(slowWriteSettled, false);
    releaseSlowWrite();
    // DEGRADE, not reject: the canonical key is already published by the time
    // afterPublish runs, so throwing would FATAL an otherwise-successful run
    // (#5478 / #5863 review). The cursor stays unwritten so the cohort replays.
    const outcome = await publish;
    assert.equal(outcome.completionState, 'DEGRADED');
    assert.equal(outcome.freshnessMetaPatch.status, 'error');
    assert.equal(outcome.freshnessMetaPatch.errorReason, 'gdelt_bulk_outputs_incomplete');
    assert.equal(slowWriteSettled, true);
    assert.equal(stateWritten, false);
  });

  it('settles sibling outputs after a rejection and does not write state', async () => {
    const data = publicationData();
    let releaseSlowWrite;
    let stateWritten = false;
    const slowWrite = new Promise((resolve) => {
      releaseSlowWrite = resolve;
    });
    const publish = afterPublish(data, undefined, {
      _writeExtraKey: async (key) => {
        if (key === 'gdelt:intel:tone:military') {
          throw new Error('timeline failed');
        }
        if (key === 'gdelt:intel:vol:military') return slowWrite;
        if (key === GDELT_BULK_STATE_KEY) stateWritten = true;
        return undefined;
      },
      _writeExtraKeyWithMeta: async () => true,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stateWritten, false);
    releaseSlowWrite();
    const outcome = await publish;
    assert.equal(outcome.completionState, 'DEGRADED', 'a failed sibling output degrades, never FATALs');
    assert.equal(outcome.freshnessMetaPatch.errorReason, 'gdelt_bulk_outputs_incomplete');
    assert.equal(stateWritten, false, 'the cursor is held so the cohort replays next tick');
  });

  it('degrades instead of crashing when only the cursor write fails', async () => {
    const data = publicationData();
    const outcome = await afterPublish(data, undefined, {
      _writeExtraKey: async (key) => {
        if (key === GDELT_BULK_STATE_KEY) throw new Error('cursor write failed');
        return undefined;
      },
      _writeExtraKeyWithMeta: async () => true,
    });
    assert.equal(outcome.completionState, 'DEGRADED');
    assert.equal(outcome.freshnessMetaPatch.errorReason, 'gdelt_bulk_cursor_write_failed');
  });
});

// #5864: three constants must stay in lockstep or the zero-headroom class
// returns — the cron cadence, the seeder's own staleness budget, and the two
// alerting surfaces that read the same seed-meta key.
describe('gdelt materializer freshness constants stay in lockstep (#5864)', () => {
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

  it('cron cadence, RUN_SEED_OPTS.maxStaleMin, health and seed-health agree', () => {
    const registry = JSON.parse(read('../scripts/railway-services.json'));
    const entry = registry.find((service) => service.service === 'seed-gdelt-intel');
    assert.ok(entry, 'the materializer service entry must exist');
    assert.match(entry.cronSchedule, /^\*\/15 /, 'the materializer runs every 15 minutes');
    assert.equal(
      entry.entry,
      'scripts/seed-gdelt-bulk-materializer.mjs',
      'the service must run the materializer, not the retired DOC seeder',
    );

    const cronMin = 15;
    const maxStaleMin = RUN_SEED_OPTS.maxStaleMin;
    assert.ok(
      maxStaleMin >= cronMin * 2,
      `maxStaleMin ${maxStaleMin} must allow at least one missed tick (2x ${cronMin}min)`,
    );

    const healthSrc = read('../api/health.js');
    const healthEntry = healthSrc.match(
      /gdeltIntel:\s*\{\s*key:\s*'seed-meta:intelligence:gdelt-intel',\s*maxStaleMin:\s*(\d+)/,
    );
    assert.ok(healthEntry, 'api/health.js must gate gdeltIntel on the seed-meta key');
    assert.equal(
      Number(healthEntry[1]),
      maxStaleMin,
      'api/health.js and RUN_SEED_OPTS must use the same staleness budget',
    );

    const seedHealthSrc = read('../api/seed-health.js');
    const seedHealthEntry = seedHealthSrc.match(
      /'intelligence:gdelt-intel':\s*\{[^}]*intervalMin:\s*(\d+)/,
    );
    assert.ok(seedHealthEntry, 'api/seed-health.js must track the materializer');
    const intervalMin = Number(seedHealthEntry[1]);
    assert.ok(
      intervalMin * 2 >= maxStaleMin && intervalMin * 2 <= maxStaleMin + cronMin,
      `seed-health intervalMin ${intervalMin} (alerts at ${intervalMin * 2}min) must track`
      + ` the ${maxStaleMin}min health budget, not the retired 4h cron`,
    );
  });

  it('every published product outlives the staleness budget that gates it', () => {
    // A TTL at or under its gate expires the payload before the staleness warn
    // can fire, paging EMPTY/crit for a merely-late tick (#5309 / #5864).
    const ttlByKey = new Map(
      RUN_SEED_OPTS.preserveKeyTtls.map(({ key, ttlSeconds }) => [key, ttlSeconds]),
    );
    const positiveTtl = ttlByKey.get(POSITIVE_EVENTS_BOOTSTRAP_KEY);
    assert.ok(positiveTtl, 'the bootstrap key must carry a preserved TTL');
    const healthSrc = read('../api/health.js');
    const gate = healthSrc.match(/positiveGeoEvents:\s*\{[^}]*maxStaleMin:\s*(\d+)/);
    assert.ok(gate, 'api/health.js must gate positiveGeoEvents');
    assert.ok(
      positiveTtl > Number(gate[1]) * 60,
      `positive-events TTL ${positiveTtl}s must outlive its ${gate[1]}min health gate`,
    );
  });
});
