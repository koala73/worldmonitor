// src/data/firmsCsv.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquisitionMsUtc,
  filterTrailing24h,
  isLikelyCsv,
  parseFirmsCsv,
} from './firmsCsv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'firms-viirs-noaa20-sample.csv'),
  'utf8'
);

const HEADER = 'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight';

test('fixture parses to 45 records with finite lat/lon/frp', () => {
  const records = parseFirmsCsv(FIXTURE);
  assert.ok(Array.isArray(records));
  assert.equal(records.length, 45);
  for (const record of records) {
    assert.ok(Number.isFinite(record.lat), `lat finite: ${record.lat}`);
    assert.ok(Number.isFinite(record.lon), `lon finite: ${record.lon}`);
    assert.ok(Number.isFinite(record.frp), `frp finite: ${record.frp}`);
    assert.ok(record.lat >= -90 && record.lat <= 90);
    assert.ok(record.lon >= -180 && record.lon <= 180);
  }
});

test('fixture first row maps every field, categorical confidence preserved raw', () => {
  const first = parseFirmsCsv(FIXTURE)[0];
  assert.equal(first.lat, 38.99488);
  assert.equal(first.lon, -121.67046);
  assert.equal(first.brightness, 303.6); // bright_ti4
  assert.equal(first.brightnessTi5, 290.73); // bright_ti5
  assert.equal(first.frp, 0.53);
  assert.equal(first.confidence, 'n'); // categorical, passed through untouched
  assert.equal(first.daynight, 'N');
  assert.equal(first.acqDate, '2026-07-16');
  assert.equal(first.acqTime, '1006'); // string, as-is
  assert.equal(first.satellite, 'N20');
  assert.equal(first.instrument, 'VIIRS');
});

test('acquisitionMsUtc: "1006" = 10:06 UTC', () => {
  assert.equal(acquisitionMsUtc('2026-07-16', '1006'), Date.UTC(2026, 6, 16, 10, 6));
});

test('acquisitionMsUtc: non-zero-padded "45" = 00:45 UTC', () => {
  assert.equal(acquisitionMsUtc('2026-07-16', '45'), Date.UTC(2026, 6, 16, 0, 45));
});

test('acquisitionMsUtc: "0" = midnight UTC; garbage → NaN', () => {
  assert.equal(acquisitionMsUtc('2026-07-16', '0'), Date.UTC(2026, 6, 16, 0, 0));
  assert.ok(Number.isNaN(acquisitionMsUtc('not-a-date', '1006')));
  assert.ok(Number.isNaN(acquisitionMsUtc('2026-07-16', 'xx')));
});

test('header-only input → []', () => {
  assert.deepEqual(parseFirmsCsv(`${HEADER}\n`), []);
  assert.deepEqual(parseFirmsCsv(HEADER), []);
});

test('CRLF line endings and trailing newline tolerated', () => {
  const text = `${HEADER}\r\n38.99488,-121.67046,303.6,0.39,0.36,2026-07-16,1006,N20,VIIRS,n,2.0NRT,290.73,0.53,N\r\n\r\n`;
  const records = parseFirmsCsv(text);
  assert.equal(records.length, 1);
  assert.equal(records[0].lat, 38.99488);
  assert.equal(records[0].daynight, 'N'); // no trailing \r leaking into the last field
});

test('malformed rows are skipped, valid rows kept', () => {
  const text = [
    HEADER,
    'not,enough,fields',
    'garbage-line-with-no-commas',
    'NaN,-121.67046,303.6,0.39,0.36,2026-07-16,1006,N20,VIIRS,n,2.0NRT,290.73,0.53,N',
    '38.99488,-121.67046,303.6,0.39,0.36,2026-07-16,1006,N20,VIIRS,n,2.0NRT,290.73,0.53,N',
  ].join('\n');
  const records = parseFirmsCsv(text);
  assert.equal(records.length, 1);
  assert.equal(records[0].lat, 38.99488);
});

test('HTML error page detected as not-CSV', () => {
  const html = '\n  <html><body><h1>Service unavailable</h1></body></html>';
  assert.equal(isLikelyCsv(html), false);
  assert.equal(parseFirmsCsv(html), null);
});

test('plain-text upstream error detected as not-CSV', () => {
  const text = 'Invalid MAP_KEY.';
  assert.equal(isLikelyCsv(text), false);
  assert.equal(parseFirmsCsv(text), null);
});

test('isLikelyCsv accepts the real fixture', () => {
  assert.equal(isLikelyCsv(FIXTURE), true);
});

test('filterTrailing24h: window is [now − 24 h, now + 2 h] inclusive', () => {
  const now = Date.UTC(2026, 6, 16, 12, 0); // 2026-07-16 12:00Z
  const rec = (acqDate, acqTime) => ({ acqDate, acqTime });
  const records = [
    rec('2026-07-15', '1159'), // 24h + 1min old → out
    rec('2026-07-15', '1200'), // exactly 24h old → in (inclusive)
    rec('2026-07-15', '1201'), // 23h59m old → in
    rec('2026-07-16', '1130'), // recent → in
    rec('2026-07-16', '1400'), // now + 2h (slack boundary) → in
    rec('2026-07-16', '1401'), // beyond forward slack → out
    rec('bad-date', '1006'), // unparseable → out
  ];
  const kept = filterTrailing24h(records, now);
  assert.deepEqual(
    kept.map((r) => `${r.acqDate} ${r.acqTime}`),
    ['2026-07-15 1200', '2026-07-15 1201', '2026-07-16 1130', '2026-07-16 1400']
  );
});

test('filterTrailing24h on the fixture keeps everything for a same-night now', () => {
  const records = parseFirmsCsv(FIXTURE);
  // Fixture is a days=2 pull; all rows are 2026-07-16 (10:06Z–21:27Z), so at
  // 2026-07-17 02:00Z every detection is 4.5–16 h old — all inside 24 h.
  const kept = filterTrailing24h(records, Date.UTC(2026, 6, 17, 2, 0));
  assert.equal(kept.length, records.length);
});
