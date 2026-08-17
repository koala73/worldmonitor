import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  extractGdeltBulkCsv,
  materializeGdeltBulk,
  parseGdeltBulkDescriptors,
  parseGdeltGkgCsv,
  toArticle as gdeltArticleForTests,
} from '../scripts/_gdelt-bulk-materializer.mjs';

function gkgRow({
  id,
  timestamp = '20260730120000',
  domain = 'reuters.com',
  url,
  title,
  themes,
  tone = '3.5,10,2,8,1,2,3',
  locations = '1#Cairo, Egypt#EG#EG11#30.0444#31.2357#-290692',
  // V2ENHANCEDLOCATIONS carries an EXTRA ADM2 sub-field (9 total) and must not
  // be read with the V1 offsets — reading it as V1 puts ADM2 in latitude and
  // the real latitude in longitude (#5863 review, P0 on live data).
  enhancedLocations = '1#Cairo, Egypt#EG#EG11#3086#30.0444#31.2357#-290692#128',
  image = 'https://images.example.test/photo.jpg',
}) {
  const fields = Array.from({ length: 27 }, () => '');
  fields[0] = id;
  fields[1] = timestamp;
  fields[3] = domain;
  fields[4] = url;
  fields[8] = themes;
  fields[9] = locations;
  fields[10] = enhancedLocations;
  fields[15] = tone;
  fields[18] = image;
  fields[26] = `<PAGE_TITLE>${title}</PAGE_TITLE>`;
  return fields.join('\t');
}

function makeStoredZip(filename, text) {
  const name = Buffer.from(filename);
  const body = Buffer.from(text);
  const zip = Buffer.alloc(30 + name.length + body.length);
  zip.writeUInt32LE(0x04034b50, 0);
  zip.writeUInt16LE(20, 4);
  zip.writeUInt16LE(0, 6);
  zip.writeUInt16LE(0, 8);
  zip.writeUInt32LE(body.length, 18);
  zip.writeUInt32LE(body.length, 22);
  zip.writeUInt16LE(name.length, 26);
  zip.writeUInt16LE(0, 28);
  name.copy(zip, 30);
  body.copy(zip, 30 + name.length);
  return zip;
}

describe('GDELT bulk manifest selection', () => {
  it('selects only unseen gkg/export snapshots and rewrites them to the GCS mirror', () => {
    const manifest = [
      '100 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa http://data.gdeltproject.org/gdeltv2/20260730114500.gkg.csv.zip',
      '200 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb http://data.gdeltproject.org/gdeltv2/20260730114500.export.CSV.zip',
      '110 cccccccccccccccccccccccccccccccc http://data.gdeltproject.org/gdeltv2/20260730120000.gkg.csv.zip',
      '210 dddddddddddddddddddddddddddddddd http://data.gdeltproject.org/gdeltv2/20260730120000.export.CSV.zip',
    ].join('\n');

    const selected = parseGdeltBulkDescriptors(manifest, {
      afterTimestamp: '20260730114500',
    });

    assert.deepEqual(selected.map(({ kind, timestamp }) => ({ kind, timestamp })), [
      { kind: 'gkg', timestamp: '20260730120000' },
      { kind: 'export', timestamp: '20260730120000' },
    ]);
    assert.ok(selected.every(({ url }) =>
      url.startsWith('https://storage.googleapis.com/data.gdeltproject.org/gdeltv2/')));
  });

  it('fails closed on a descriptor hosted outside the official GDELT origin', () => {
    assert.throws(
      () => parseGdeltBulkDescriptors(
        '100 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa https://evil.example/gdeltv2/20260730120000.gkg.csv.zip',
      ),
      /untrusted GDELT bulk URL/,
    );
  });

  it('tracks GKG and export cursors independently when one feed lags', () => {
    const manifest = [
      '100 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa http://data.gdeltproject.org/gdeltv2/20260730120000.gkg.csv.zip',
      '200 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb http://data.gdeltproject.org/gdeltv2/20260730120000.export.CSV.zip',
      '110 cccccccccccccccccccccccccccccccc http://data.gdeltproject.org/gdeltv2/20260730121500.gkg.csv.zip',
    ].join('\n');

    const selected = parseGdeltBulkDescriptors(manifest, {
      afterTimestamp: {
        gkg: '20260730121500',
        export: '20260730114500',
      },
    });

    assert.deepEqual(selected.map(({ kind, timestamp }) => ({ kind, timestamp })), [
      { kind: 'export', timestamp: '20260730120000' },
    ]);
  });

  it('ignores only the incomplete first line from a suffix-range manifest read', () => {
    const selected = parseGdeltBulkDescriptors([
      'deltproject.org/gdeltv2/20260730114500.gkg.csv.zip',
      '110 cccccccccccccccccccccccccccccccc http://data.gdeltproject.org/gdeltv2/20260730120000.gkg.csv.zip',
    ].join('\n'));
    assert.deepEqual(selected.map(({ timestamp }) => timestamp), ['20260730120000']);
  });

  it('caps each feed independently to the newest requested descriptors', () => {
    const manifest = [
      '100 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa http://data.gdeltproject.org/gdeltv2/20260730113000.gkg.csv.zip',
      '200 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb http://data.gdeltproject.org/gdeltv2/20260730113000.export.CSV.zip',
      '110 cccccccccccccccccccccccccccccccc http://data.gdeltproject.org/gdeltv2/20260730114500.gkg.csv.zip',
      '210 dddddddddddddddddddddddddddddddd http://data.gdeltproject.org/gdeltv2/20260730114500.export.CSV.zip',
      '120 eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee http://data.gdeltproject.org/gdeltv2/20260730120000.gkg.csv.zip',
      '220 ffffffffffffffffffffffffffffffff http://data.gdeltproject.org/gdeltv2/20260730120000.export.CSV.zip',
    ].join('\n');

    const selected = parseGdeltBulkDescriptors(manifest, { maxPerKind: 2 });

    assert.deepEqual(selected.map(({ kind, timestamp }) => ({ kind, timestamp })), [
      { kind: 'gkg', timestamp: '20260730114500' },
      { kind: 'export', timestamp: '20260730114500' },
      { kind: 'gkg', timestamp: '20260730120000' },
      { kind: 'export', timestamp: '20260730120000' },
    ]);
  });
});

describe('GDELT GKG bulk parsing', () => {
  it('extracts a bounded GKG ZIP only when its descriptor filename matches', () => {
    const descriptor = {
      kind: 'gkg',
      timestamp: '20260730120000',
      size: 1,
      md5: 'a'.repeat(32),
      url: 'https://storage.googleapis.com/data.gdeltproject.org/gdeltv2/20260730120000.gkg.csv.zip',
    };
    const csv = gkgRow({
      id: 'zip-row',
      url: 'https://example.com/zip',
      title: 'ZIP title',
      themes: 'MILITARY,1',
    });
    assert.equal(
      extractGdeltBulkCsv(
        makeStoredZip('20260730120000.gkg.csv', csv),
        descriptor,
      ),
      csv,
    );
    assert.throws(
      () => extractGdeltBulkCsv(
        makeStoredZip('20260730121500.gkg.csv', csv),
        descriptor,
      ),
      /unexpected GDELT bulk filename/,
    );
  });

  it('extracts title, URL, tone, themes, and validated locations', () => {
    const [record] = parseGdeltGkgCsv(gkgRow({
      id: '20260730120000-1',
      url: 'https://reuters.com/world/example',
      title: 'Peace deal &amp; medical breakthrough',
      themes: 'PEACEKEEPING,12;MEDICAL,33;PROTEST,77',
    }));

    assert.equal(record.title, 'Peace deal & medical breakthrough');
    assert.equal(record.url, 'https://reuters.com/world/example');
    assert.equal(record.source, 'reuters.com');
    assert.equal(record.tone, 3.5);
    assert.deepEqual(record.themes, ['PEACEKEEPING', 'MEDICAL', 'PROTEST']);
    assert.deepEqual(record.locations, [{
      name: 'Cairo, Egypt',
      countryCode: 'EG',
      latitude: 30.0444,
      longitude: 31.2357,
    }]);
  });

  it('drops unsafe URLs and out-of-range locations', () => {
    const records = parseGdeltGkgCsv(gkgRow({
      id: 'bad',
      url: 'javascript:alert(1)',
      title: 'Unsafe',
      themes: 'PROTEST,1',
      locations: '1#Nowhere#ZZ#ZZ00#95#200#x',
    }));
    assert.deepEqual(records, []);
  });
});

describe('GDELT bulk derived products', () => {
  it('materializes topic articles and rolling tone/volume buckets without DOC API data', () => {
    const timestamp = '20260730120000';
    const records = parseGdeltGkgCsv([
      gkgRow({
        id: 'mil-1',
        url: 'https://reuters.com/military',
        title: 'Naval exercise expands',
        themes: 'MILITARY,1;MARITIME,2',
        tone: '-4.5,1,2,3',
      }),
      gkgRow({
        id: 'cyber-1',
        url: 'https://example.com/cyber',
        title: 'Ransomware attack disrupts port',
        themes: 'CYBER_ATTACK,1',
        tone: '-2,1,2,3',
      }),
    ].join('\n'));

    const result = materializeGdeltBulk({
      batches: [{ timestamp, records }],
      previous: {},
      nowMs: Date.parse('2026-07-30T12:05:00Z'),
    });

    assert.deepEqual(result.intel.topics.map((topic) => topic.id), [
      'military', 'cyber', 'nuclear', 'sanctions', 'intelligence', 'maritime',
    ]);
    assert.equal(result.intel.topics.find((topic) => topic.id === 'military').articles.length, 1);
    assert.equal(result.intel.topics.find((topic) => topic.id === 'cyber').articles.length, 1);
    assert.deepEqual(result.timelines.military.tone, [{
      date: '2026-07-30T12:00:00.000Z',
      value: -4.5,
    }]);
    assert.deepEqual(result.timelines.military.vol, [{
      date: '2026-07-30T12:00:00.000Z',
      value: 1,
    }]);
    assert.equal(
      result.timelines.military.fetchedAt,
      '2026-07-30T12:00:00.000Z',
    );
    assert.deepEqual(result.reference.articles.map((article) => article.url), [
      'https://example.com/cyber',
      'https://reuters.com/military',
    ]);
  });

  it('derives unrest and positive geo events from the same records', () => {
    const timestamp = '20260730120000';
    const protestRows = Array.from({ length: 5 }, (_, index) => gkgRow({
      id: `protest-${index}`,
      url: `https://news.example/protest-${index}`,
      title: `Protest report ${index}`,
      themes: 'PROTEST,1',
      tone: '-3,1,2,3',
    }));
    const positiveRows = Array.from({ length: 3 }, (_, index) => gkgRow({
      id: `positive-${index}`,
      url: `https://health.example/positive-${index}`,
      title: `Medical breakthrough ${index}`,
      themes: 'MEDICAL,1',
      tone: '4,1,2,3',
    }));

    const result = materializeGdeltBulk({
      batches: [{
        timestamp,
        records: parseGdeltGkgCsv([...protestRows, ...positiveRows].join('\n')),
      }],
      previous: {},
      nowMs: Date.parse('2026-07-30T12:05:00Z'),
    });

    assert.equal(result.unrest.events.length, 1);
    assert.equal(result.unrest.events[0].sourceType, 'UNREST_SOURCE_TYPE_GDELT');
    assert.match(result.unrest.events[0].title, /5 reports/);
    assert.equal(
      result.unrest.events[0].occurredAt,
      Date.parse('2026-07-30T12:00:00Z'),
      'rolling evidence must retain source time instead of looking fresh on every publish',
    );
    assert.equal(result.positive.events.length, 1);
    assert.equal(result.positive.events[0].category, 'science-health');
    assert.equal(result.positive.events[0].count, 3);
    assert.equal(result.positive.events[0].timestamp, Date.parse('2026-07-30T12:00:00Z'));
  });

  it('merges prior articles and timeline buckets while pruning beyond the rolling windows', () => {
    const nowMs = Date.parse('2026-07-30T12:05:00Z');
    const current = parseGdeltGkgCsv(gkgRow({
      id: 'current',
      url: 'https://example.com/current',
      title: 'Military exercise today',
      themes: 'MILITARY,1',
      tone: '-1,1,2,3',
    }));
    const previous = {
      intel: {
        topics: [{
          id: 'military',
          fetchedAt: '2026-07-30T11:45:00.000Z',
          articles: [
            {
              title: 'Prior military report',
              url: 'https://example.com/prior',
              source: 'example.com',
              date: '2026-07-30T11:45:00.000Z',
              image: '',
              language: 'English',
              tone: -2,
            },
            {
              title: 'Expired report',
              url: 'https://example.com/expired',
              source: 'example.com',
              date: '2026-07-28T11:45:00.000Z',
              image: '',
              language: 'English',
              tone: -3,
            },
          ],
        }],
      },
      timelines: {
        military: {
          tone: [
            { date: '2026-07-29T12:00:00.000Z', value: -2 },
            { date: '2026-07-01T12:00:00.000Z', value: -9 },
          ],
          vol: [{ date: '2026-07-29T12:00:00.000Z', value: 4 }],
        },
      },
    };

    const result = materializeGdeltBulk({
      batches: [{ timestamp: '20260730120000', records: current }],
      previous,
      nowMs,
    });

    const military = result.intel.topics.find((topic) => topic.id === 'military');
    assert.deepEqual(military.articles.map((article) => article.url), [
      'https://example.com/current',
      'https://example.com/prior',
    ]);
    assert.deepEqual(result.timelines.military.tone.map((point) => point.date), [
      '2026-07-29T12:00:00.000Z',
      '2026-07-30T12:00:00.000Z',
    ]);
  });

  it('keeps an unchanged topic timeline and its source freshness old', () => {
    const previousFetchedAt = '2026-07-29T11:45:00.000Z';
    const previousCyber = {
      fetchedAt: previousFetchedAt,
      tone: [{ date: previousFetchedAt, value: -3 }],
      vol: [{ date: previousFetchedAt, value: 2 }],
    };
    const priorSanctionsToneAt = '2026-07-28T10:00:00.000Z';
    const priorSanctionsVolAt = '2026-07-28T11:00:00.000Z';
    const current = parseGdeltGkgCsv(gkgRow({
      id: 'military-only',
      url: 'https://example.com/military-only',
      title: 'Military exercise today',
      themes: 'MILITARY,1',
      tone: '-1,1,2,3',
    }));

    const result = materializeGdeltBulk({
      batches: [{ timestamp: '20260730120000', records: current }],
      previous: {
        timelines: {
          cyber: previousCyber,
          sanctions: {
            tone: [{ date: priorSanctionsToneAt, value: -2 }],
            vol: [{ date: priorSanctionsVolAt, value: 3 }],
          },
        },
      },
      nowMs: Date.parse('2026-07-30T12:05:00Z'),
    });

    assert.deepEqual(result.timelines.cyber.tone, previousCyber.tone);
    assert.deepEqual(result.timelines.cyber.vol, previousCyber.vol);
    assert.equal(result.timelines.cyber.toneFetchedAt, previousFetchedAt);
    assert.equal(result.timelines.cyber.volFetchedAt, previousFetchedAt);
    assert.equal(result.timelines.cyber.fetchedAt, previousFetchedAt);
    assert.equal(
      result.timelines.sanctions.toneFetchedAt,
      priorSanctionsToneAt,
      'legacy tone freshness falls back to the latest retained tone point',
    );
    assert.equal(
      result.timelines.sanctions.volFetchedAt,
      priorSanctionsVolAt,
      'legacy volume freshness falls back to the latest retained volume point',
    );
    assert.equal(
      result.timelines.sanctions.fetchedAt,
      priorSanctionsVolAt,
      'compatibility freshness remains the newest series freshness',
    );
    assert.equal(
      result.timelines.military.toneFetchedAt,
      '2026-07-30T12:00:00.000Z',
      'a current match uses the newest source bucket rather than run time',
    );
  });

  it('does not re-date old tone freshness when only volume freshness is current', () => {
    const oldToneAt = '2026-07-28T10:00:00.000Z';
    const currentVolumeAt = '2026-07-30T11:45:00.000Z';
    const current = parseGdeltGkgCsv(gkgRow({
      id: 'military-only',
      url: 'https://example.com/military-only',
      title: 'Military exercise today',
      themes: 'MILITARY,1',
      tone: '-1,1,2,3',
    }));

    const result = materializeGdeltBulk({
      batches: [{ timestamp: '20260730120000', records: current }],
      previous: {
        timelines: {
          cyber: {
            tone: [{ date: oldToneAt, value: -4 }],
            vol: [{ date: currentVolumeAt, value: 8 }],
            toneFetchedAt: oldToneAt,
            volFetchedAt: currentVolumeAt,
            fetchedAt: currentVolumeAt,
          },
        },
      },
      nowMs: Date.parse('2026-07-30T12:05:00Z'),
    });

    assert.equal(result.timelines.cyber.toneFetchedAt, oldToneAt);
    assert.equal(result.timelines.cyber.volFetchedAt, currentVolumeAt);
    assert.equal(result.timelines.cyber.fetchedAt, currentVolumeAt);
  });
});


describe('GKG column layout — #5863 review round', () => {
  it('reads coordinates from V1LOCATIONS, not the V2 enhanced column whose layout differs', () => {
    // Verbatim-shaped real rows: V1LOCATIONS is 7 '#'-fields
    // (Type#FullName#CC#ADM1#Lat#Lon#FeatureID); V2ENHANCEDLOCATIONS is 9
    // (Type#FullName#CC#ADM1#ADM2#Lat#Lon#FeatureID#Offset). On a live cohort
    // reading the V2 column with V1 offsets produced latitude 0 for 2831/2831
    // locations, with the real latitude shifted into longitude.
    const numericAdm2 = gkgRow({
      id: 'gkg-v2-numeric-adm2',
      url: 'https://reuters.com/brussels',
      title: 'Brussels summit opens',
      themes: 'TAX_FNCACT',
      locations: '4#Brussels, Bruxelles-Brussel, Belgium#BE#BE11#50.8333#4.33333#-1955538',
      enhancedLocations: '4#Brussels, Bruxelles-Brussel, Belgium#BE#BE11#5850#50.8333#4.33333#-1955538#8',
    });
    const emptyAdm2 = gkgRow({
      id: 'gkg-v2-empty-adm2',
      url: 'https://reuters.com/minnesota',
      title: 'Minnesota storm warning',
      themes: 'NATURAL_DISASTER',
      locations: '2#Minnesota, United States#US#USMN#45.7326#-93.9196#MN',
      // The empty-ADM2 shape is what survived the mis-parse as latitude 0.
      enhancedLocations: '2#Minnesota, United States#US#USMN##45.7326#-93.9196#MN#153',
    });

    const [brussels, minnesota] = parseGdeltGkgCsv([numericAdm2, emptyAdm2].join('\n'));

    assert.deepEqual(brussels.locations, [{
      name: 'Brussels, Bruxelles-Brussel, Belgium',
      countryCode: 'BE',
      latitude: 50.8333,
      longitude: 4.33333,
    }], 'a numeric ADM2 must never be read as latitude');
    assert.deepEqual(minnesota.locations, [{
      name: 'Minnesota, United States',
      countryCode: 'US',
      latitude: 45.7326,
      longitude: -93.9196,
    }], 'an empty ADM2 must not collapse latitude to 0 and shift longitude');
    for (const record of [brussels, minnesota]) {
      assert.notEqual(record.locations[0].latitude, 0, 'derived geo events must not land on the equator');
    }
  });

  it('publishes article dates in the GDELT compact seendate format the UI parses', () => {
    // src/services/gdelt-intel.ts formatArticleDate slices positionally
    // (YYYYMMDDTHHMMSSZ). An ISO date parses to '' there and every UI age
    // label renders blank (#5863 review).
    const [record] = parseGdeltGkgCsv([gkgRow({
      id: 'gkg-date-format',
      url: 'https://reuters.com/date',
      title: 'Date format check',
      themes: 'TAX_FNCACT',
      timestamp: '20260730123000',
    })].join('\n'));
    const article = gdeltArticleForTests(record);
    assert.equal(article.date, '20260730T123000Z', 'artlist parity: compact seendate, not ISO');
    // Mirror the consumer's positional parse to prove it resolves.
    const d = article.date;
    const parsed = Date.parse(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}Z`);
    assert.ok(Number.isFinite(parsed), `the UI positional parser must resolve ${d}`);
  });

  it('caps per-record themes and locations so one degenerate row cannot bloat the state key', () => {
    const manyThemes = Array.from({ length: 400 }, (_, i) => `THEME_${i},10`).join(';');
    const manyLocations = Array.from({ length: 200 }, (_, i) =>
      `1#Place ${i}${'x'.repeat(300)}#EG#EG11#${(10 + (i % 70)).toFixed(4)}#${(20 + (i % 100)).toFixed(4)}#${i}`).join(';');
    const [record] = parseGdeltGkgCsv([gkgRow({
      id: 'gkg-degenerate',
      url: 'https://reuters.com/degenerate',
      title: 'Degenerate row',
      themes: manyThemes,
      locations: manyLocations,
    })].join('\n'));
    assert.ok(record.themes.length <= 60, `themes must be capped, got ${record.themes.length}`);
    assert.ok(record.locations.length <= 20, `locations must be capped, got ${record.locations.length}`);
    for (const location of record.locations) {
      assert.ok(location.name.length <= 200, 'location names must be bounded');
    }
  });
});
