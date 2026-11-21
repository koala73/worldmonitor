// US restricted-party lists that are not in the Consolidated Screening List
// (DoD 1260H, Section 889, FCC Covered List, UFLPA) feed screening and the
// change feed. The fixture is a real excerpt of the 2026-11-18 release.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  URP_MANIFEST_URL, URP_RELEASE_URL, URP_SOURCES, URP_STATUS_URL, URP_TIMEOUT_MS,
  ingestUsRestrictedEntries, parseUrpList, sha256Hex, urpFetchBudget,
} from '../scripts/_us-restricted-sanctions.mjs';
import { screenSanctions } from '../server/_shared/sanctions-screen.ts';

const file = name => readFileSync(new URL(`./fixtures/us-restricted-parties/${name}`, import.meta.url));
const manifest = JSON.parse(file('manifest.json').toString('utf8'));
const now = Date.UTC(2026, 10, 18, 12);

const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const TAG_RELEASE_URL = 'https://github.com/Mattbusel/us-restricted-parties/releases/download/data-2026-11-18/';

// A status.json run at `at` that rebuilt the fixture release unchanged.
function heartbeat(at, lists = {}, extra = {}) {
  return {
    schema: 1, url: URP_STATUS_URL, generated_at: iso(at), ok: true, build_ok: true, job_status: 'success',
    last_release_tag: 'data-2026-11-18', released_this_run: false, lists_unchanged_since_last_release: true,
    lists: Object.fromEntries(Object.entries(manifest.lists).map(([key, entry]) => [key, {
      fetched_at: iso(at), upstream_ok: true, rows: entry.records, sha256: entry.sha256,
      data_date: iso(at).slice(0, 10), error: null, ...lists[key],
    }])),
    affiliates: { built: true, upstream_ok: true, stale: false, error: null },
    errors: {},
    ...extra,
  };
}

// Serves the fixture release the way GitHub does: release downloads land on the
// asset host. Without a heartbeat, status.json is a 404.
function release({ files = {}, status = {}, heartbeat: hb = null } = {}) {
  const seen = [];
  const assetOrigin = 'https://release-assets.githubusercontent.com/';
  const fetchFn = async (url, init) => {
    seen.push({ url, init });
    if (url === URP_STATUS_URL) {
      return hb === null ? new Response('404: Not Found', { status: 404 }) : new Response(typeof hb === 'string' ? hb : JSON.stringify(hb));
    }
    for (const base of [URP_RELEASE_URL, TAG_RELEASE_URL]) {
      if (url.startsWith(base)) return Response.redirect(assetOrigin + url.slice(base.length), 302);
    }
    assert.ok(url.startsWith(assetOrigin));
    const name = url.slice(assetOrigin.length);
    if (status[name]) return new Response('unavailable', { status: status[name] });
    return new Response(files[name] ?? file(name));
  };
  return { fetchFn, seen };
}

describe('US restricted-party list parsing', () => {
  it('maps a 1260H row to the seeder record shape with its alias, citation and source link', () => {
    const { records, error, publishedAt } = parseUrpList('us_dod_1260h', file('us_dod_1260h.jsonl'), manifest.lists.us_dod_1260h, now);
    assert.equal(error, null);
    assert.equal(publishedAt, Date.parse('2026-11-18T02:14:50Z'));
    const qihoo = records.find(r => r.name === '360 Security Technology, Inc.');
    assert.equal(qihoo.id, 'US-1260H:us_dod_1260h-360-security-technology-inc');
    assert.deepEqual(qihoo.sourceLists, ['US-1260H']);
    assert.equal(qihoo.entityType, 'SANCTIONS_ENTITY_TYPE_ENTITY');
    assert.deepEqual(qihoo._aliases, ['Qihoo 360']);
    assert.equal(qihoo.effectiveAt, String(Date.UTC(2026, 5, 10)));
    assert.equal(qihoo._notice, 'FR Doc 2026-11571');
    assert.match(qihoo._url, /^https:\/\/www\.federalregister\.gov\/documents\/2026\/06\/10\/2026-11571\//);
    assert.ok(records.some(r => r.name === '14th Research Institute of CETC'), 'named subsidiaries are their own rows');
  });

  it('keeps a citation that is not a Federal Register document number as written', () => {
    const [dahua] = parseUrpList('us_far_889', file('us_far_889.jsonl'), manifest.lists.us_far_889, now).records;
    assert.match(dahua._notice, /^48 CFR 52\.204-25/);
    assert.equal(dahua._url, 'https://www.ecfr.gov/current/title-48/section-52.204-25');
  });

  it('rejects a file whose bytes or row count do not match the manifest', () => {
    const body = file('us_dhs_uflpa.jsonl');
    const entry = manifest.lists.us_dhs_uflpa;
    assert.equal(parseUrpList('us_dhs_uflpa', Buffer.concat([body, Buffer.from('\n')]), entry, now).error, 'URP_HASH_MISMATCH');
    assert.equal(parseUrpList('us_dhs_uflpa', body, { ...entry, records: 3 }, now).error, 'URP_COUNT_MISMATCH');
    for (const records of [undefined, '2', 2.5, 0]) {
      assert.equal(parseUrpList('us_dhs_uflpa', body, { ...entry, records }, now).error, 'URP_COUNT_MISMATCH');
    }
    assert.equal(parseUrpList('us_dhs_uflpa', body, undefined, now).error, 'URP_LIST_MISSING');
  });

  it('drops a row whose RECORD_ID belongs to another list or is malformed', () => {
    const rows = [
      { RECORD_ID: 'us_dod_1260h-acme', NAME_ORG: 'Acme', RECORD_TYPE: 'ORGANIZATION' },
      { RECORD_ID: 'us_dhs_uflpa-other-list', NAME_ORG: 'Other', RECORD_TYPE: 'ORGANIZATION' },
      { RECORD_ID: 'us_dod_1260h-Bad Id', NAME_ORG: 'Bad', RECORD_TYPE: 'ORGANIZATION' },
    ];
    const body = Buffer.from(`${rows.map(r => JSON.stringify(r)).join('\n')}\n`);
    const { records } = parseUrpList('us_dod_1260h', body, { sha256: sha256Hex(body), records: 3, fetched_at: '2026-11-18T00:00:00Z' }, now);
    assert.deepEqual(records.map(r => r.name), ['Acme']);
  });

  it('rejects lists without a valid upstream fetch timestamp', () => {
    const list = 'us_far_889';
    const entry = manifest.lists[list];
    const body = file(entry.file);
    for (const fetched_at of [null, 'invalid', '2027-01-01T00:00:00Z']) {
      const result = parseUrpList(list, body, { ...entry, fetched_at }, now);
      assert.equal(result.error, 'URP_FETCH_UNCONFIRMED');
      assert.deepEqual(result.records, []);
    }
  });
});

describe('US restricted-party list ingest', () => {
  it('fetches the manifest and the four list files, skipping the interim BIOSECURE file', async () => {
    const { fetchFn, seen } = release();
    const { lists, error } = await ingestUsRestrictedEntries({ fetchFn, now });
    assert.equal(error, null);
    assert.deepEqual(URP_SOURCES.slice().sort(), ['US-1260H', 'US-889', 'US-FCC', 'US-UFLPA']);
    assert.deepEqual(Object.keys(lists).sort(), [...URP_SOURCES].sort());
    assert.ok(Object.values(lists).every(list => list.error === null && list.records.length > 0));
    assert.equal(seen[0].url, URP_STATUS_URL);
    assert.equal(seen[1].url, URP_MANIFEST_URL);
    assert.ok(!seen.some(({ url }) => url.includes('biosecure')));
    assert.equal(seen.length, 11);
    assert.ok(seen.every(({ init }) => init.redirect === 'manual' && init.headers['User-Agent'] && init.signal === seen[0].init.signal));
  });

  it('fails only the list whose file is unavailable or altered', async () => {
    const { fetchFn } = release({ status: { 'us_fcc_covered.jsonl': 502 }, files: { 'us_far_889.jsonl': Buffer.from('{}\n') } });
    const { lists, error } = await ingestUsRestrictedEntries({ fetchFn, now });
    assert.equal(error, null);
    assert.equal(lists['US-FCC'].error, 'URP_FETCH_FAILED');
    assert.equal(lists['US-889'].error, 'URP_HASH_MISMATCH');
    assert.equal(lists['US-1260H'].error, null);
    assert.equal(lists['US-UFLPA'].error, null);
  });

  it('rejects a reported upstream failure while keeping the other lists from an older release', async () => {
    const reportedFailure = { ...manifest, errors: { us_fcc_covered: 'agency request failed' } };
    const later = now + 30 * 86400_000;
    const { fetchFn, seen } = release({ files: { 'manifest.json': JSON.stringify(reportedFailure) }, heartbeat: heartbeat(later - 3600_000) });
    const { lists, error } = await ingestUsRestrictedEntries({ fetchFn, now: later });
    assert.equal(error, null);
    assert.equal(lists['US-FCC'].error, 'URP_UPSTREAM_FAILED');
    assert.ok(!seen.some(({ url }) => url.endsWith('us_fcc_covered.jsonl')));
    for (const source of ['US-1260H', 'US-889', 'US-UFLPA']) {
      const verified = lists[source];
      assert.equal(verified.error, null);
      assert.ok(verified.records.length > 0);
    }
  });

  it('keeps completed lists when another request runs out of time', async t => {
    const deadline = new AbortController();
    t.mock.method(AbortSignal, 'timeout', () => deadline.signal);
    const fixture = release();
    const fetchFn = async (url, init) => {
      if (!url.endsWith('us_fcc_covered.jsonl')) return fixture.fetchFn(url, init);
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        setImmediate(() => deadline.abort(new DOMException('Deadline exceeded', 'TimeoutError')));
      });
    };
    const { lists, error } = await ingestUsRestrictedEntries({ fetchFn, now });
    assert.equal(error, null);
    assert.equal(lists['US-FCC'].error, 'URP_FETCH_DEADLINE');
    for (const source of ['US-1260H', 'US-889', 'US-UFLPA']) {
      assert.equal(lists[source].error, null);
      assert.ok(lists[source].records.length > 0);
    }
  });

  it('fails every list when the manifest is unavailable', async () => {
    const { fetchFn } = release({ status: { 'manifest.json': 503 } });
    assert.deepEqual(await ingestUsRestrictedEntries({ fetchFn, now }), { lists: {}, error: 'HTTP 503' });
  });

  it('rejects off-host and non-HTTPS redirects before making another request', async () => {
    for (const location of ['https://example.com/manifest.json', 'http://github.com/manifest.json']) {
      const seen = [];
      const fetchFn = async url => {
        seen.push(url);
        return Response.redirect(location, 302);
      };
      assert.deepEqual(await ingestUsRestrictedEntries({ fetchFn, now }), { lists: {}, error: 'URP_UNEXPECTED_HOST' });
      assert.deepEqual(seen, [URP_STATUS_URL, URP_MANIFEST_URL]);
    }
  });

  it('caps redirects even when they stay on an allowed host', async () => {
    let requests = 0;
    const fetchFn = async () => {
      requests += 1;
      return new Response(null, { status: 302, headers: { Location: './manifest.json' } });
    };
    assert.deepEqual(await ingestUsRestrictedEntries({ fetchFn, now }), { lists: {}, error: 'URP_INVALID_REDIRECT' });
    assert.equal(requests, 8, 'four for the heartbeat, four for the manifest');
  });

  it('skips the download when the deadline leaves too little time', async () => {
    assert.equal(urpFetchBudget(Date.now() + 1_000, Date.now()), 0);
    assert.equal(urpFetchBudget(Infinity, Date.now()), URP_TIMEOUT_MS);
    const { fetchFn, seen } = release();
    assert.deepEqual(await ingestUsRestrictedEntries({ fetchFn, deadlineAt: Date.now() + 1_000 }), { lists: {}, error: 'URP_FETCH_DEADLINE' });
    assert.equal(seen.length, 0);
  });
});

describe('US restricted-party heartbeat', () => {
  // Five quiet days after the 2026-11-18 release: no new release, daily heartbeats.
  const later = now + 5 * 86400_000;
  const UNCONFIRMED = { records: [], publishedAt: 0, error: 'URP_UNCONFIRMED' };

  it('keeps serving an unchanged release that a fresh heartbeat confirms', async () => {
    const ranAt = later - 2 * 3600_000;
    const { fetchFn, seen } = release({ heartbeat: heartbeat(ranAt) });
    const { lists, error } = await ingestUsRestrictedEntries({ fetchFn, now: later });
    assert.equal(error, null);
    for (const source of URP_SOURCES) {
      assert.equal(lists[source].error, null);
      assert.ok(lists[source].records.length > 0);
      assert.equal(lists[source].publishedAt, ranAt);
    }
    assert.equal(seen[0].url, URP_STATUS_URL);
    assert.equal(seen[1].url, `${TAG_RELEASE_URL}manifest.json`, 'reads the release the heartbeat checked');
    assert.ok(seen.slice(1).every(({ url }) => !url.startsWith(URP_RELEASE_URL)));
  });

  it('a stale heartbeat or a failed build confirms nothing, so an old release falls back to last-good', async () => {
    for (const hb of [heartbeat(later - 31 * 3600_000), heartbeat(later - 3600_000, {}, { build_ok: false })]) {
      const { fetchFn, seen } = release({ heartbeat: hb });
      const { lists, error } = await ingestUsRestrictedEntries({ fetchFn, now: later });
      assert.equal(error, null);
      for (const source of URP_SOURCES) assert.deepEqual(lists[source], UNCONFIRMED);
      assert.equal(seen[1].url, URP_MANIFEST_URL);
    }
  });

  it('a stale heartbeat still serves lists the release itself read in the last 30 hours', async () => {
    const { fetchFn } = release({ heartbeat: heartbeat(now - 40 * 3600_000) });
    const { lists } = await ingestUsRestrictedEntries({ fetchFn, now });
    for (const source of URP_SOURCES) {
      assert.equal(lists[source].error, null);
      assert.equal(lists[source].publishedAt, Date.parse(manifest.built_at));
    }
  });

  it('a missing or unreadable heartbeat falls back to the latest release', async () => {
    for (const hb of [null, 'not json', { ...heartbeat(later - 3600_000), schema: 2 }]) {
      const fresh = await ingestUsRestrictedEntries({ fetchFn: release({ heartbeat: hb }).fetchFn, now });
      assert.equal(fresh.error, null);
      assert.ok(URP_SOURCES.every(source => fresh.lists[source].error === null), 'a release under 30h old needs no heartbeat');
      const old = await ingestUsRestrictedEntries({ fetchFn: release({ heartbeat: hb }).fetchFn, now: later });
      assert.equal(old.error, null);
      for (const source of URP_SOURCES) assert.deepEqual(old.lists[source], UNCONFIRMED);
    }
  });

  it('a reported failure for one list leaves only that list unconfirmed', async () => {
    const ranAt = later - 3600_000;
    const hb = heartbeat(ranAt, {
      us_fcc_covered: { upstream_ok: false, fetched_at: null, error: 'HTTP 503' },
      us_dhs_uflpa: { sha256: '0'.repeat(64) },
      us_far_889: { rows: 2 },
    }, { ok: false, errors: { us_fcc_covered: 'HTTP 503' } });
    const { fetchFn } = release({ heartbeat: hb });
    const { lists, error } = await ingestUsRestrictedEntries({ fetchFn, now: later });
    assert.equal(error, null);
    assert.deepEqual(lists['US-FCC'], UNCONFIRMED);
    assert.deepEqual(lists['US-UFLPA'], UNCONFIRMED, 'a hash that differs from the release is not a confirmation');
    assert.deepEqual(lists['US-889'], UNCONFIRMED, 'a row count that differs from the release is not a confirmation');
    assert.equal(lists['US-1260H'].error, null);
    assert.equal(lists['US-1260H'].publishedAt, ranAt);
  });

  it('an affiliates error does not degrade the four lists', async () => {
    const ranAt = later - 3600_000;
    const hb = heartbeat(ranAt, {}, {
      ok: false,
      affiliates: { built: true, upstream_ok: false, stale: true, error: 'GLEIF request failed' },
      errors: { affiliates: 'GLEIF request failed' },
    });
    const { lists, error } = await ingestUsRestrictedEntries({ fetchFn: release({ heartbeat: hb }).fetchFn, now: later });
    assert.equal(error, null);
    for (const source of URP_SOURCES) {
      assert.equal(lists[source].error, null);
      assert.equal(lists[source].publishedAt, ranAt);
    }
  });
});

describe('screening with the US restricted-party rows', () => {
  // The same fields the seeder writes into sanctions:entities:v1.
  const indexRow = e => ({ id: e.id, name: e.name, et: 'entity', cc: e.countryCodes, pr: e.programs, al: e._aliases, ids: [], sl: e.sourceLists });

  it('returns FCC Covered List, UFLPA and 1260H names, including an alias', async () => {
    const { fetchFn } = release();
    const { lists } = await ingestUsRestrictedEntries({ fetchFn, now });
    const index = Object.values(lists).flatMap(list => list.records).map(indexRow);
    const [fcc] = screenSanctions(index, 'China Mobile International USA');
    assert.equal(fcc.id, 'US-FCC:us_fcc_covered-china-mobile-international-usa-inc');
    assert.equal(fcc.score, 100);
    const [uflpa] = screenSanctions(index, 'Aksu Aodu Sugar Industry');
    assert.deepEqual(uflpa.sl, ['US-UFLPA']);
    const [alias] = screenSanctions(index, 'Qihoo 360');
    assert.equal(alias.matched_on, 'alias');
    assert.deepEqual(alias.sl, ['US-1260H']);
  });
});
