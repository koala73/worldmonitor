#!/usr/bin/env node
// Rebuilds GDELT per-country day buckets for past UTC days from GDELT's public
// archive, with the parser, day rebuild and summariser the bulk materializer
// uses (scripts/_gdelt-country-events.mjs). The numbers are the ones the live
// scorer would have read at the chosen clock. Research tool for the CII v15
// recalibration (docs/methodology/cii-v15-recalibration.md); never run by a seeder.
//
// Two archive sources:
//   v2     the 96 quarter-hour GDELT 2.0 event exports of a day, verified
//          against the master file list's size and MD5. This is the stream
//          the seeder reads.
//   daily  GDELT's one-file-a-day event export (the 1.0 column layout, which
//          lacks the three ADM2 columns). Rows are mapped to the 2.0 layout
//          and parsed by the same parser. One request a day instead of 96;
//          how closely it tracks v2 is measured, not assumed.
//
// Requests are sequential with a User-Agent. Parsed per-file counts are cached
// as JSON under --cache-dir (a fresh temp directory when omitted); raw ZIPs are
// not kept.
//
//   node scripts/cii-gdelt-archive-rebuild.mjs v2 --from 2026-11-06 --to 2026-11-12 --out days.json
//   node scripts/cii-gdelt-archive-rebuild.mjs v2 --from 2026-11-13 --to 2026-11-13 --cursor 20261113094500 --out partial.json
//   node scripts/cii-gdelt-archive-rebuild.mjs daily --from 2026-11-06 --to 2026-11-12 --out daily.json
//   node scripts/cii-gdelt-archive-rebuild.mjs summarize --snapshot days.json --now 2026-11-13T09:52:15.410Z
//   node scripts/cii-gdelt-archive-rebuild.mjs compare --snapshot days.json,partial.json --cursor 20261113094500 \
//     --fixture tests/fixtures/cii/2026-11-13T0952Z.json
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import {
  GDELT_MASTER_FILELIST_URL,
  extractGdeltExportCsv,
  parseGdeltRecentExports,
} from './_conflict-gdelt-bulk.mjs';
import {
  countryEventsDayStamps,
  parseCountryEventsExport,
  rebuildCountryEventsDay,
  summarizeCountryEvents,
} from './_gdelt-country-events.mjs';

const USER_AGENT = 'WorldMonitor/1.0 (+https://www.worldmonitor.app)';
const DAY_MS = 86_400_000;
const COHORTS_PER_DAY = 96;
// Same storage origin as the seeder's export URLs.
const GDELT_V2_DIR_URL = new URL('./', GDELT_MASTER_FILELIST_URL).href;
const GDELT_DAILY_DIR_URL = new URL('../events/', GDELT_MASTER_FILELIST_URL).href;
const MAX_MASTER_BYTES = 400_000_000;
const MAX_DAILY_ZIP_BYTES = 60_000_000;
const MAX_DAILY_CSV_BYTES = 400_000_000;
const REQUEST_TIMEOUT_MS = 120_000;
const ATTEMPTS = 4;

/** GDELT 1.0 daily rows (58 fields) → the 2.0 export layout (61 fields). */
export function dailyRowToExportRow(line) {
  const f = line.split('\t');
  if (f.length !== 58) return null;
  return [...f.slice(0, 39), '', ...f.slice(39, 46), '', ...f.slice(46, 53), '', ...f.slice(53)].join('\t');
}

/** Per-country counters of one daily file, parsed by the seeder's parser. */
export function parseDailyEventsFile(csv) {
  const rows = [];
  for (const line of String(csv || '').split('\n')) {
    const row = dailyRowToExportRow(line.replace(/\r$/, ''));
    if (row) rows.push(row);
  }
  return parseCountryEventsExport(rows.join('\n'));
}

/** Extracts the single entry of a GDELT daily ZIP (stored or deflated, local header only). */
export async function extractDailyCsv(zipBytes, date) {
  const { inflateRawSync } = await import('node:zlib');
  const zip = Buffer.from(zipBytes);
  if (zip.length < 30 || zip.readUInt32LE(0) !== 0x04034b50) throw new Error('invalid daily ZIP header');
  const flags = zip.readUInt16LE(6);
  const method = zip.readUInt16LE(8);
  const nameLength = zip.readUInt16LE(26);
  const extraLength = zip.readUInt16LE(28);
  const name = zip.subarray(30, 30 + nameLength).toString('utf8');
  if (name !== `${date.replaceAll('-', '')}.export.CSV`) throw new Error(`unexpected daily ZIP entry ${name}`);
  const start = 30 + nameLength + extraLength;
  let compressedSize = zip.readUInt32LE(18);
  if (flags & 0x8) {
    // Sizes live in the central directory when the data-descriptor flag is set.
    const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error('daily ZIP has no end of central directory');
    const central = zip.readUInt32LE(eocd + 16);
    compressedSize = zip.readUInt32LE(central + 20);
  }
  const data = zip.subarray(start, start + compressedSize);
  if (method === 0) return data.toString('utf8');
  if (method !== 8) throw new Error(`unsupported daily ZIP method ${method}`);
  return inflateRawSync(data, { maxOutputLength: MAX_DAILY_CSV_BYTES }).toString('utf8');
}

export function datesBetween(from, to) {
  const out = [];
  for (let ms = Date.parse(`${from}T00:00:00Z`); ms <= Date.parse(`${to}T00:00:00Z`); ms += DAY_MS) {
    out.push(new Date(ms).toISOString().slice(0, 10));
  }
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchBuffer(fetchImpl, url, maxBytes) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > maxBytes) throw new Error(`response over ${maxBytes} bytes for ${url}`);
      buffer.storageMd5 = storageMd5(response.headers);
      return buffer;
    } catch (error) {
      lastError = error;
      if (attempt < ATTEMPTS) await sleep(2_000 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

/** A ZIP whose first entry has zero compressed and uncompressed size and no data descriptor. */
export function isEmptyExportZip(zip) {
  return zip.length >= 30 && zip.readUInt32LE(0) === 0x04034b50 && !(zip.readUInt16LE(6) & 0x8)
    && zip.readUInt32LE(18) === 0 && zip.readUInt32LE(22) === 0;
}

/** The object's MD5 from Cloud Storage's `x-goog-hash` header, as hex, or null. */
export function storageMd5(headers) {
  const value = headers?.get?.('x-goog-hash') ?? '';
  const match = /(?:^|,)\s*md5=([A-Za-z0-9+/=]+)/.exec(value);
  return match ? Buffer.from(match[1], 'base64').toString('hex') : null;
}

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}

function writeJson(path, value) {
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(value));
  renameSync(temp, path);
}

/** Every 2.0 event export in the master file list, keyed by its timestamp. */
export async function loadMasterDescriptors({ cacheDir, fetchImpl = globalThis.fetch }) {
  const path = join(cacheDir, 'masterfilelist.txt');
  let text = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (text === null) {
    const buffer = await fetchBuffer(fetchImpl, GDELT_MASTER_FILELIST_URL, MAX_MASTER_BYTES);
    if (!buffer) throw new Error('GDELT master file list not found');
    text = buffer.toString('utf8');
    writeFileSync(path, text);
  }
  return new Map(parseGdeltRecentExports(text, Number.MAX_SAFE_INTEGER)
    .map((descriptor) => [descriptor.exportTimestamp, descriptor]));
}

/**
 * One UTC day from its 2.0 exports, through `cursor` when the cursor falls on
 * that day. A day whose every expected export is listed and verified goes
 * through the seeder's rebuildCountryEventsDay. Exports missing from the
 * archive leave the day short (`cohorts` < expected), which the summariser
 * excludes exactly as it would a day the live seeder never completed.
 */
export async function rebuildV2Day(date, { descriptors, cacheDir, fetchImpl = globalThis.fetch, cursor = '', log = () => {} }) {
  const dir = join(cacheDir, 'v2');
  mkdirSync(dir, { recursive: true });
  const stamps = countryEventsDayStamps(date, cursor);
  const batches = [];
  const missing = [];
  for (const stamp of stamps) {
    const cachePath = join(dir, `${stamp}.json`);
    let countries = readJson(cachePath);
    // null marks a published but empty export, which counts as missing.
    if (countries === null) { missing.push(stamp); continue; }
    if (countries === undefined) {
      const descriptor = descriptors.get(stamp);
      if (!descriptor) { missing.push(stamp); continue; }
      const zip = await fetchBuffer(fetchImpl, `${GDELT_V2_DIR_URL}${stamp}.export.CSV.zip`, descriptor.size);
      if (!zip) { missing.push(stamp); continue; }
      if (zip.length !== descriptor.size || createHash('md5').update(zip).digest('hex') !== descriptor.md5) {
        throw new Error(`GDELT export ${stamp} failed size/MD5 verification`);
      }
      if (isEmptyExportZip(zip)) {
        // The seeder's extractor rejects a zero-size entry, so production never
        // counts this quarter-hour either.
        writeJson(cachePath, null);
        missing.push(stamp);
        continue;
      }
      countries = parseCountryEventsExport(extractGdeltExportCsv(zip, stamp));
      writeJson(cachePath, countries);
    }
    batches.push({ timestamp: stamp, countries });
  }
  if (missing.length) log(`${date}: ${missing.length} of ${stamps.length} exports missing from the archive`);
  if (!missing.length) return rebuildCountryEventsDay(date, batches, cursor);
  const day = { cohorts: batches.length, strikeCohorts: batches.length, countries: {}, missingExports: missing };
  for (const { countries } of batches) {
    for (const [iso2, values] of Object.entries(countries)) {
      const current = day.countries[iso2] ?? [0, 0, 0, 0];
      day.countries[iso2] = current.map((value, i) => value + (Number(values[i]) || 0));
    }
  }
  return day;
}

/** Day counters from the daily file, keyed like a stored day (no cohort count). */
export async function rebuildDailyDay(date, { cacheDir, fetchImpl = globalThis.fetch, md5s }) {
  const dir = join(cacheDir, 'daily');
  mkdirSync(dir, { recursive: true });
  const cachePath = join(dir, `${date}.json`);
  const cached = readJson(cachePath);
  if (cached !== undefined) return cached;
  const name = `${date.replaceAll('-', '')}.export.CSV.zip`;
  const zip = await fetchBuffer(fetchImpl, `${GDELT_DAILY_DIR_URL}${name}`, MAX_DAILY_ZIP_BYTES);
  const result = { date, available: false, countries: {} };
  if (zip) {
    const expected = md5s?.get(name);
    const actual = createHash('md5').update(zip).digest('hex');
    if (expected && actual !== expected) {
      // GDELT's md5sums list is stale for some dates. The bytes are accepted only
      // when they match the stored object's own MD5, and the mismatch is recorded.
      if (zip.storageMd5 !== actual) throw new Error(`GDELT daily file ${name} failed MD5 verification`);
      result.listMd5Mismatch = { listed: expected, storage: actual };
    }
    result.available = true;
    result.verified = Boolean(expected);
    result.countries = parseDailyEventsFile(await extractDailyCsv(zip, date));
  }
  writeJson(cachePath, result);
  return result;
}

export async function loadDailyMd5s({ cacheDir, fetchImpl = globalThis.fetch }) {
  const path = join(cacheDir, 'daily-md5sums.txt');
  let text = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (text === null) {
    const buffer = await fetchBuffer(fetchImpl, `${GDELT_DAILY_DIR_URL}md5sums`, 10_000_000);
    text = buffer ? buffer.toString('utf8') : '';
    writeFileSync(path, text);
  }
  const map = new Map();
  for (const line of text.split('\n')) {
    const [md5, name] = line.trim().split(/\s+/);
    if (/^[a-f0-9]{32}$/.test(md5 ?? '') && name) map.set(name, md5);
  }
  return map;
}

/** A snapshot shaped like the seeder's stored `days` + `cursor`, for summarizeCountryEvents. */
export function snapshotFromDays(days, cursor) {
  return { cursor, days };
}

export function summarizeAt(snapshot, nowIso) {
  return summarizeCountryEvents(snapshot, Date.parse(nowIso));
}

/**
 * Field-by-field comparison of a rebuilt summary with a capture's
 * `gdeltCountryEvents`, over the capture's countries. Integer counts and
 * medians must match exactly; `current` within `currentTolerance`.
 */
export function compareWithCapture(rebuilt, captured, { currentTolerance = 0.05 } = {}) {
  const mismatches = [];
  let checked = 0;
  const check = (iso2, field, got, want, tolerance = 0) => {
    checked += 1;
    const ok = got === want || (Number.isFinite(got) && Number.isFinite(want) && Math.abs(got - want) <= tolerance + 1e-9);
    if (!ok) mismatches.push({ iso2, field, rebuilt: got ?? null, captured: want ?? null });
  };
  for (const flag of ['baselineReady', 'currentComplete', 'weekReady']) check('*', flag, rebuilt[flag], captured[flag]);
  check('*', 'strikeDays', JSON.stringify(rebuilt.strikeDays), JSON.stringify(captured.strikeDays));
  for (const [iso2, want] of Object.entries(captured.byCountry ?? {})) {
    const got = rebuilt.byCountry?.[iso2];
    for (const family of ['conflict', 'protest']) {
      check(iso2, `${family}.current`, got?.[family]?.current, want[family]?.current, currentTolerance);
      check(iso2, `${family}.baselineMedian`, got?.[family]?.baselineMedian, want[family]?.baselineMedian);
    }
    for (const field of ['articles', 'conflict', 'protest']) check(iso2, `week.${field}`, got?.week?.[field], want.week?.[field]);
    check(iso2, 'strikes', JSON.stringify(got?.strikes ?? null), JSON.stringify(want.strikes ?? null));
  }
  return { countries: Object.keys(captured.byCountry ?? {}).length, checked, mismatches };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      cursor: { type: 'string', default: '' },
      'cache-dir': { type: 'string' },
      out: { type: 'string' },
      snapshot: { type: 'string' },
      now: { type: 'string' },
      fixture: { type: 'string' },
    },
  });
  const downloads = command === 'v2' || command === 'daily';
  const cacheDir = downloads ? (values['cache-dir'] ?? mkdtempSync(join(tmpdir(), 'gdelt-archive-'))) : null;
  if (cacheDir) mkdirSync(cacheDir, { recursive: true });
  const log = (message) => process.stderr.write(`${message}\n`);
  if (command === 'v2') {
    const descriptors = await loadMasterDescriptors({ cacheDir });
    const days = {};
    for (const date of datesBetween(values.from, values.to)) {
      const cursor = values.cursor.startsWith(date.replaceAll('-', '')) ? values.cursor : '';
      days[date] = await rebuildV2Day(date, { descriptors, cacheDir, cursor, log });
      log(`${date}: ${days[date].cohorts} cohorts`);
    }
    const output = { source: 'gdelt-v2-exports', cursor: values.cursor || null, days };
    if (values.out) writeJson(values.out, output); else process.stdout.write(`${JSON.stringify(output)}\n`);
  } else if (command === 'daily') {
    const md5s = await loadDailyMd5s({ cacheDir });
    const days = {};
    for (const date of datesBetween(values.from, values.to)) {
      days[date] = await rebuildDailyDay(date, { cacheDir, md5s });
      log(`${date}: ${days[date].available ? 'ok' : 'missing'}`);
    }
    const output = { source: 'gdelt-daily-events', days };
    if (values.out) writeJson(values.out, output); else process.stdout.write(`${JSON.stringify(output)}\n`);
  } else if (command === 'summarize') {
    const snapshot = JSON.parse(readFileSync(values.snapshot, 'utf8'));
    process.stdout.write(`${JSON.stringify(summarizeAt(snapshot, values.now), null, 2)}\n`);
  } else if (command === 'compare') {
    // --snapshot may be a comma-separated list; later files override earlier days.
    const days = {};
    for (const path of values.snapshot.split(',')) Object.assign(days, JSON.parse(readFileSync(path, 'utf8')).days);
    const fixture = JSON.parse(readFileSync(values.fixture, 'utf8'));
    const rebuilt = summarizeCountryEvents({ cursor: values.cursor, days }, fixture.nowMs);
    const result = compareWithCapture(rebuilt, fixture.inputs.gdeltCountryEvents);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.mismatches.length) process.exitCode = 1;
  } else {
    log('usage: cii-gdelt-archive-rebuild.mjs v2|daily|summarize [options]');
    process.exitCode = 2;
    return;
  }
  if (cacheDir) log(`cache: ${cacheDir}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
}

export { COHORTS_PER_DAY };
