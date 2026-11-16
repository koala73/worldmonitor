import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import {
  compareWithCapture,
  dailyRowToExportRow,
  datesBetween,
  extractDailyCsv,
  loadMasterDescriptors,
  parseDailyEventsFile,
  rebuildDailyDay,
  rebuildV2Day,
} from '../scripts/cii-gdelt-archive-rebuild.mjs';
import {
  binomialUpperTail,
  clusterEpisodes,
  copiedMagnitudes,
  evaluateCaptureDay,
  lowerMedianIndex,
  orderEpisodes,
  requiredScanDates,
  RULE,
  SCREEN_RULE,
  admissionGate,
  selectConfirmed,
} from '../scripts/cii-unrest-episode-scan.mjs';
import {
  countryEventsDayStamps,
  parseCountryEventsExport,
  rebuildCountryEventsDay,
  summarizeCountryEvents,
} from '../scripts/_gdelt-country-events.mjs';

// 133 rows of the real 2026-11-12 12:00 UTC GDELT 2.0 export (Ukraine, Korea,
// Germany and France rows, US protest/conflict/strike rows and a few others,
// non-root and ungeolocated rows).
const SAMPLE = readFileSync(new URL('./fixtures/gdelt-export-sample-20261112120000.CSV', import.meta.url), 'utf8');
const UA = 'WorldMonitor/1.0 (+https://www.worldmonitor.app)';

function zipOf(name, text) {
  const data = Buffer.from(text, 'utf8');
  const compressed = deflateRawSync(data);
  const nameBytes = Buffer.from(name);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(8, 8);
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, nameBytes, compressed]);
}

// 2.0 row → the 1.0 daily layout: drop the three ADM2 columns.
function toDailyRow(line) {
  const f = line.split('\t');
  return [...f.slice(0, 39), ...f.slice(40, 47), ...f.slice(48, 55), ...f.slice(56)].join('\t');
}

function fakeArchive({ date, missing = [], corrupt = [] }) {
  const cacheDir = mkdtempSync(join(tmpdir(), 'gdelt-archive-test-'));
  const files = new Map();
  const lines = [];
  for (const stamp of countryEventsDayStamps(date)) {
    if (missing.includes(stamp)) continue;
    const zip = zipOf(`${stamp}.export.CSV`, SAMPLE);
    files.set(`${stamp}.export.CSV.zip`, zip);
    const md5 = corrupt.includes(stamp) ? '0'.repeat(32) : createHash('md5').update(zip).digest('hex');
    lines.push(`${zip.length} ${md5} http://data.gdeltproject.org/gdeltv2/${stamp}.export.CSV.zip`);
  }
  writeFileSync(join(cacheDir, 'masterfilelist.txt'), `${lines.join('\n')}\n`);
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, userAgent: init?.headers?.['User-Agent'] });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    inFlight -= 1;
    const body = files.get(url.split('/').pop());
    if (!body) return new Response('not found', { status: 404 });
    return new Response(body, { status: 200 });
  };
  return { cacheDir, fetchImpl, calls, maxInFlight: () => maxInFlight };
}

describe('GDELT archive rebuild', () => {
  it('parses the committed export sample to independently recounted articles', () => {
    // Recounted with awk over distinct SOURCEURLs of root events per ActionGeo country.
    const counts = parseCountryEventsExport(SAMPLE);
    assert.deepEqual(counts.FR, [5, 0, 1, 0]);
    assert.deepEqual(counts.DE, [4, 0, 0, 0]);
    assert.deepEqual(counts.KR, [1, 0, 0, 0]);
    assert.deepEqual(counts.UA.slice(0, 3), [6, 1, 0]);
    assert.deepEqual(counts.US.slice(0, 3), [8, 5, 1]);
  });

  it('maps daily-file rows to the 2.0 layout so the seeder parser reads them identically', () => {
    const daily = SAMPLE.split('\n').filter(Boolean).map(toDailyRow);
    assert.ok(daily.every((row) => row.split('\t').length === 58));
    const back = dailyRowToExportRow(daily[0]).split('\t');
    const original = SAMPLE.split('\n')[0].split('\t');
    assert.equal(back.length, 61);
    for (const i of [0, 17, 25, 27, 28, 29, 53, 60]) assert.equal(back[i], original[i]);
    assert.deepEqual(parseDailyEventsFile(daily.join('\n')), parseCountryEventsExport(SAMPLE));
    assert.equal(dailyRowToExportRow(SAMPLE.split('\n')[0]), null, 'a 61-field row is not a daily row');
  });

  it('rebuilds a full day from 96 verified exports exactly as the seeder would, then serves it from cache', async () => {
    const date = '2026-11-12';
    const archive = fakeArchive({ date });
    const descriptors = await loadMasterDescriptors({ cacheDir: archive.cacheDir, fetchImpl: archive.fetchImpl });
    const day = await rebuildV2Day(date, { descriptors, cacheDir: archive.cacheDir, fetchImpl: archive.fetchImpl });
    const perFile = parseCountryEventsExport(SAMPLE);
    const expected = rebuildCountryEventsDay(date, countryEventsDayStamps(date).map((timestamp) => ({ timestamp, countries: perFile })));
    assert.deepEqual(day, expected);
    assert.equal(day.cohorts, 96);
    assert.deepEqual(day.countries.FR, perFile.FR.map((value) => value * 96));
    assert.equal(archive.calls.length, 96);
    assert.equal(archive.maxInFlight(), 1, 'requests are sequential');
    assert.ok(archive.calls.every((call) => call.userAgent === UA));
    assert.ok(archive.calls.every((call) => call.url.startsWith('https://storage.googleapis.com/data.gdeltproject.org/gdeltv2/')));

    const again = await rebuildV2Day(date, { descriptors, cacheDir: archive.cacheDir, fetchImpl: archive.fetchImpl });
    assert.deepEqual(again, expected);
    assert.equal(archive.calls.length, 96, 'the second rebuild reads the disk cache');
  });

  it('rebuilds the cursor day through the cursor only', async () => {
    const date = '2026-11-13';
    const archive = fakeArchive({ date });
    const descriptors = await loadMasterDescriptors({ cacheDir: archive.cacheDir, fetchImpl: archive.fetchImpl });
    const day = await rebuildV2Day(date, { descriptors, cacheDir: archive.cacheDir, fetchImpl: archive.fetchImpl, cursor: '20261113094500' });
    assert.equal(day.cohorts, 40);
    assert.equal(archive.calls.length, 40);
  });

  it('rejects an export whose MD5 does not match the master list', async () => {
    const date = '2026-11-12';
    const archive = fakeArchive({ date, corrupt: ['20261112000000'] });
    const descriptors = await loadMasterDescriptors({ cacheDir: archive.cacheDir, fetchImpl: archive.fetchImpl });
    await assert.rejects(
      rebuildV2Day(date, { descriptors, cacheDir: archive.cacheDir, fetchImpl: archive.fetchImpl }),
      /failed size\/MD5 verification/,
    );
  });

  it('leaves a day with an archive gap short, so the summariser treats it as unknown rather than calm', async () => {
    const date = '2026-11-12';
    const archive = fakeArchive({ date, missing: ['20261112101500'] });
    const descriptors = await loadMasterDescriptors({ cacheDir: archive.cacheDir, fetchImpl: archive.fetchImpl });
    const day = await rebuildV2Day(date, { descriptors, cacheDir: archive.cacheDir, fetchImpl: archive.fetchImpl });
    assert.equal(day.cohorts, 95);
    assert.deepEqual(day.missingExports, ['20261112101500']);
    const full = { cohorts: 96, strikeCohorts: 96, countries: { FR: [100, 0, 10, 0] } };
    const days = {};
    for (const d of datesBetween('2026-10-14', '2026-11-13')) days[d] = full;
    days[date] = day;
    const summary = summarizeCountryEvents({ cursor: '20261113234500', days }, Date.parse('2026-11-13T23:59:59.999Z'));
    assert.equal(summary.weekDays, 6, 'the short day is excluded from the week');
  });

  it('reads a daily-file ZIP by its dated entry name and rejects any other entry', async () => {
    const csv = SAMPLE.split('\n').filter(Boolean).map(toDailyRow).join('\n');
    assert.equal(await extractDailyCsv(zipOf('20261112.export.CSV', csv), '2026-11-12'), csv);
    await assert.rejects(extractDailyCsv(zipOf('20261111.export.CSV', csv), '2026-11-12'), /unexpected daily ZIP entry/);
  });

  it('records a missing daily file as unavailable and caches it', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'gdelt-daily-test-'));
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return new Response('', { status: 404 }); };
    const first = await rebuildDailyDay('2015-03-01', { cacheDir, fetchImpl, md5s: new Map() });
    assert.equal(first.available, false);
    await rebuildDailyDay('2015-03-01', { cacheDir, fetchImpl, md5s: new Map() });
    assert.equal(calls, 1);
  });
});

describe('capture comparison', () => {
  const summary = {
    baselineReady: true, currentComplete: true, weekReady: true, strikeDays: { '2026-11-12': 96 },
    byCountry: {
      FR: { conflict: { current: 12.3, baselineMedian: 15 }, protest: { current: 4, baselineMedian: 3.5 }, week: { articles: 2400, conflict: 90, protest: 40 } },
      KR: { conflict: { current: 1, baselineMedian: 1 }, protest: { current: 0, baselineMedian: 0 }, week: { articles: 600, conflict: 9, protest: 3 }, strikes: { '2026-11-12': [1, 90] } },
    },
  };

  it('accepts an identical rebuild and rounding-level current differences only', () => {
    const rebuilt = structuredClone(summary);
    rebuilt.byCountry.FR.conflict.current = 12.35;
    rebuilt.byCountry.US = { conflict: { current: 1, baselineMedian: 1 } };
    const result = compareWithCapture(rebuilt, summary);
    assert.deepEqual(result.mismatches, []);
    assert.equal(result.countries, 2);
  });

  it('reports every differing count, median, strike day and readiness flag', () => {
    const rebuilt = structuredClone(summary);
    rebuilt.byCountry.FR.week.protest = 41;
    rebuilt.byCountry.FR.protest.baselineMedian = 3;
    delete rebuilt.byCountry.KR.strikes;
    rebuilt.weekReady = false;
    const fields = compareWithCapture(rebuilt, summary).mismatches.map((m) => `${m.iso2}:${m.field}`);
    assert.deepEqual(fields.sort(), ['*:weekReady', 'FR:protest.baselineMedian', 'FR:week.protest', 'KR:strikes']);
  });
});

describe('P15b episode rule', () => {
  it('computes exact binomial upper tails', () => {
    assert.ok(Math.abs(binomialUpperTail(8, 10, 0.5) - 56 / 1024) < 1e-12);
    assert.equal(binomialUpperTail(0, 10, 0.3), 1);
    assert.ok(binomialUpperTail(60, 1000, 0.02) < 1e-9);
  });

  // 40 days of [articles, conflict, protest, strikes]; norm share 1%.
  function series({ weekProtest = 5, currentProtest = 5, quietDays = 0, articles = 200 } = {}) {
    const days = {};
    for (const date of datesBetween('2020-01-01', '2020-02-09')) days[date] = [articles, 0, Math.round(articles / 100), 0];
    const T = '2020-02-09';
    const week = datesBetween('2020-02-02', '2020-02-08');
    week.forEach((date, i) => { days[date] = [articles, 0, i < quietDays ? 2 : weekProtest, 0]; });
    days[T] = [articles, 0, currentProtest, 0];
    return { T, read: (date) => days[date] ?? null };
  }

  it('qualifies a sustained, significant, well-supported rise to five times the norm share', () => {
    const { T, read } = series({ weekProtest: 10, currentProtest: 10 });
    const result = evaluateCaptureDay(T, read);
    assert.deepEqual(result.failed, []);
    assert.equal(result.qualifies, true);
    assert.equal(result.normShare, 0.01);
    assert.equal(result.ratio, 5);
    assert.equal(result.elevatedDays, 7);
  });

  it('fails each registered criterion on its own', () => {
    const cases = [
      [{ weekProtest: 10, currentProtest: 1 }, 'currentDay'],
      [{ weekProtest: 10, currentProtest: 10, quietDays: 3 }, 'elevatedDays'],
      [{ weekProtest: 3, currentProtest: 10 }, 'ratio'],
      [{ weekProtest: 4, currentProtest: 10 }, 'weekProtest'],
    ];
    for (const [input, criterion] of cases) {
      const { T, read } = series(input);
      const result = evaluateCaptureDay(T, read);
      assert.ok(result.failed.includes(criterion), `${criterion}: ${result.failed}`);
    }
    // Under 200 weekly articles (OQ11), and a norm with too few protest articles.
    const thin = series({ articles: 20, weekProtest: 6, currentProtest: 6 });
    const thinResult = evaluateCaptureDay(thin.T, thin.read);
    assert.ok(thinResult.failed.includes('weekArticles'));
    assert.ok(thinResult.failed.includes('normProtest'));
  });

  it('treats a missing week day as incomplete, never as quiet', () => {
    const { T, read } = series({ weekProtest: 10, currentProtest: 10 });
    const result = evaluateCaptureDay(T, (date) => (date === '2020-02-05' ? null : read(date)));
    assert.equal(result.qualifies, false);
    assert.deepEqual(result.failed, ['completeness']);
  });

  it('clusters qualifying days within seven days into one episode at its peak ratio', () => {
    const day = (date, ratio) => ({ date, ratio });
    const episodes = clusterEpisodes('FR', [day('2020-01-01', 2.5), day('2020-01-05', 3.1), day('2020-01-12', 2.2), day('2020-01-20', 4)]);
    assert.equal(episodes.length, 2);
    assert.equal(episodes[0].peak.date, '2020-01-05');
    assert.equal(episodes[0].qualifyingDays, 3);
    assert.equal(episodes[1].first, '2020-01-20');
  });

  it('orders by peak ratio, then date, then ISO2, and takes the lower median', () => {
    const ep = (iso2, date, ratio) => ({ iso2, peak: { date, ratio } });
    const ordered = orderEpisodes([ep('US', '2020-01-01', 3), ep('FR', '2019-01-01', 3), ep('DE', '2019-01-01', 3), ep('GB', '2018-01-01', 2)]);
    assert.deepEqual(ordered.map((e) => e.iso2), ['GB', 'DE', 'FR', 'US']);
    assert.equal(lowerMedianIndex(4), 1);
    assert.equal(lowerMedianIndex(5), 2);
    assert.equal(lowerMedianIndex(0), -1);
  });

  it('scans the whole window plus the first capture\'s 35-day lead-in, whatever the caller asks', () => {
    const dates = requiredScanDates();
    assert.equal(dates[0], '2015-02-25');
    assert.equal(dates.at(-1), '2026-10-31');
    assert.equal(dates.length, datesBetween('2015-02-25', '2026-10-31').length);
  });

  it('copies conflict, protest and week only, never strike days', () => {
    const scorer = {
      conflict: { current: 8.5, baselineMedian: 7.5 },
      protest: { current: 2.6, baselineMedian: 1 },
      week: { articles: 662, conflict: 30, protest: 12 },
      strikes: { '2026-11-10': [1, 108] },
    };
    assert.deepEqual(Object.keys(copiedMagnitudes(scorer)), ['conflict', 'protest', 'week']);
    assert.equal(copiedMagnitudes(null), null);
  });

  it('screens near-floor weeks at 90% of each volume floor and nothing else (amendment 1)', () => {
    assert.equal(SCREEN_RULE.minWeekArticles, 180);
    assert.equal(SCREEN_RULE.minWeekProtest, 31.5);
    assert.equal(SCREEN_RULE.minNormProtest, 25.2);
    for (const key of ['ratio', 'minElevatedDays', 'maxTailProbability', 'minNormDays', 'weekDays', 'normDays', 'clusterGapDays']) {
      assert.equal(SCREEN_RULE[key], RULE[key], key);
    }
    // 32 weekly protest articles: under the registered 35, inside the 90% screen.
    const { T, read } = series({ articles: 100, weekProtest: 32 / 7, currentProtest: 10 });
    const days = {};
    for (const date of datesBetween('2020-01-01', '2020-02-09')) days[date] = read(date);
    datesBetween('2020-02-02', '2020-02-08').forEach((date, i) => { days[date] = [100, 0, i < 4 ? 5 : 4, 0]; });
    const near = (date) => days[date];
    assert.deepEqual(evaluateCaptureDay(T, near).failed, ['weekProtest']);
    assert.deepEqual(evaluateCaptureDay(T, near, SCREEN_RULE).failed, []);
  });

  it('admits the daily file only when every tested ratio is within 10% of the 2.0 ratio', () => {
    const gate = { captureDays: ['2020-02-09'], ratioTolerance: 0.1 };
    const rule = { ...RULE, countries: ['FR', 'DE', 'JP'] };
    const base = series({ weekProtest: 10, currentProtest: 10 });
    const scaled = (factor) => (date) => {
      const d = base.read(date);
      if (!d) return null;
      // Inflate articles on week days only, so the ratio moves by 1/factor.
      return date >= '2020-02-02' && date <= '2020-02-08' ? [Math.round(d[0] * factor), 0, d[2], 0] : d;
    };
    const zero = (date) => (base.read(date) ? [1000, 0, 0, 0] : null);
    const v2Read = (iso2) => (iso2 === 'JP' ? zero : base.read);
    const near = admissionGate((iso2) => (iso2 === 'JP' ? zero : scaled(1.05)), v2Read, gate, rule);
    assert.equal(near.pass, true);
    assert.equal(near.rows.find((r) => r.iso2 === 'JP').tested, false);
    const far = admissionGate((iso2) => (iso2 === 'DE' ? scaled(1.2) : iso2 === 'JP' ? zero : base.read), v2Read, gate, rule);
    assert.equal(far.pass, false);
    assert.deepEqual(far.rows.filter((r) => !r.pass).map((r) => r.iso2), ['DE']);
  });

  it('selects the lower median of the confirmed episodes, ranked by their 2.0 peak ratio', () => {
    const result = (iso2, date, screenRatio, v2Ratio, confirmed) => ({
      episode: { iso2, peak: { date, ratio: screenRatio } },
      v2Evaluation: { date, ratio: v2Ratio },
      confirmed,
    });
    const { confirmed, index, selected } = selectConfirmed([
      result('FR', '2019-01-01', 2.1, 2.9, true),
      result('US', '2020-01-01', 2.2, 2.3, true),
      result('DE', '2018-01-01', 2.3, 1.5, false),
      result('GB', '2017-01-01', 2.4, 2.5, true),
    ]);
    assert.deepEqual(confirmed.map((e) => e.iso2), ['US', 'GB', 'FR']);
    assert.equal(index, 1);
    assert.equal(selected.iso2, 'GB');
    assert.equal(selected.screenPeak.ratio, 2.4);
    assert.equal(selectConfirmed([result('DE', '2018-01-01', 2.3, 1.5, false)]).selected, null);
  });

  it('pins the registered constants', () => {
    assert.deepEqual(RULE.countries, ['DE', 'FR', 'GB', 'JP', 'KR', 'PL', 'US']);
    assert.equal(RULE.minWeekArticles, 200);
    assert.equal(RULE.ratio, 2);
    assert.equal(RULE.minElevatedDays, 5);
    assert.equal(RULE.maxTailProbability, 1e-6);
  });
});
