import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { FETCH_PHASE_PUBLISH_RESERVE_MS } from '../scripts/_seed-utils.mjs';
import { GTFS_RT_TIMEOUT_MS } from '../scripts/lib/gtfsrt.mjs';

import {
  TTC_GTFS_RT_ALERTS_URL,
  TTC_GTFS_RT_MODE_ALERT_URLS,
  buildTtcAlertsSnapshot,
  fetchTtcAlertsFeed,
  ttcAlertsFreshnessMetaPatch,
  validateTtcAlertsSnapshot,
} from '../scripts/seed-ttc-alerts.mjs';

// Minimal GTFS-RT FeedMessage encoder: header + alert entities with an English
// header_text, enough for parseGtfsRtServiceAlerts to round-trip ids and text.
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function varint(value) {
  const bytes = [];
  let n = BigInt(value);
  while (n >= 0x80n) {
    bytes.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  bytes.push(Number(n));
  return Uint8Array.from(bytes);
}

const tag = (field, wire) => varint((field << 3) | wire);
const lenField = (field, bytes) => concat(tag(field, 2), varint(bytes.length), bytes);
const strField = (field, text) => lenField(field, new TextEncoder().encode(text));
const intField = (field, value) => concat(tag(field, 0), varint(value));

function encodeFeed(alerts, timestamp = 1_762_500_000) {
  const headerFields = [strField(1, '2.0')];
  if (timestamp != null) headerFields.push(intField(3, timestamp));
  const header = lenField(1, concat(...headerFields));
  const entities = alerts.map(({ id, text }) => {
    const headerText = lenField(10, lenField(1, concat(strField(1, text), strField(2, 'en'))));
    return lenField(2, concat(strField(1, id), lenField(5, headerText)));
  });
  return concat(header, ...entities);
}

// Fixture fetch: each URL maps to a protobuf body or an HTTP status. Unmapped
// URLs 404, and every requested URL is recorded.
function fixtureFetch(routes) {
  const requested = [];
  const fetch = async (url) => {
    requested.push(url);
    const route = routes[url];
    if (route instanceof Uint8Array) {
      return new Response(route, { status: 200, headers: { 'content-type': 'application/x-protobuf' } });
    }
    return new Response('', { status: typeof route === 'number' ? route : 404 });
  };
  return { fetch, requested };
}

const MODE = TTC_GTFS_RT_MODE_ALERT_URLS;

describe('TTC alerts per-mode fallback', () => {
  it('uses the combined feed as before when it works and never reads per-mode feeds', async () => {
    const { fetch, requested } = fixtureFetch({
      [TTC_GTFS_RT_ALERTS_URL]: encodeFeed([
        { id: '1', text: 'Line 1 delay' },
        { id: '2', text: '504 King diversion' },
      ]),
    });

    const feed = await fetchTtcAlertsFeed({ fetch });
    assert.deepEqual(requested, [TTC_GTFS_RT_ALERTS_URL]);
    assert.deepEqual(feed.alerts.map((alert) => alert.id), ['1', '2']);

    const snapshot = buildTtcAlertsSnapshot(feed);
    assert.equal(validateTtcAlertsSnapshot(snapshot), true);
    assert.equal(snapshot.feedSource, 'combined');
    assert.deepEqual(snapshot.missingModes, []);
    assert.deepEqual(ttcAlertsFreshnessMetaPatch(snapshot), { feedSource: 'combined', missingModes: [] });
  });

  it('publishes subway + bus alerts and records streetcar as missing when combined and streetcar 500', async () => {
    const { fetch, requested } = fixtureFetch({
      [TTC_GTFS_RT_ALERTS_URL]: 500,
      [MODE.subway]: encodeFeed([{ id: 's1', text: 'Line 2 shuttle buses' }], 1_762_500_100),
      [MODE.bus]: encodeFeed([{ id: 'b1', text: '29 Dufferin detour' }, { id: 'b2', text: '7 Bathurst delay' }], 1_762_500_050),
      [MODE.streetcar]: 500,
      [MODE.accessibility]: encodeFeed([]),
      [MODE.stops]: encodeFeed([]),
    });

    const feed = await fetchTtcAlertsFeed({ fetch });
    for (const url of Object.values(MODE)) assert.ok(requested.includes(url), `fallback must read ${url}`);
    assert.deepEqual(feed.alerts.map((alert) => alert.id).sort(), ['b1', 'b2', 's1']);
    assert.deepEqual(feed.missingModes, ['streetcar']);
    // Oldest producer stamp wins, so the content clock never reads fresher
    // than the feeds actually merged.
    assert.equal(feed.header.timestamp, 1_762_500_000);

    const snapshot = buildTtcAlertsSnapshot(feed);
    assert.equal(validateTtcAlertsSnapshot(snapshot), true);
    assert.equal(snapshot.alerts.length, 3);
    assert.equal(snapshot.feedSource, 'per-mode');
    assert.deepEqual(snapshot.missingModes, ['streetcar']);
    assert.deepEqual(ttcAlertsFreshnessMetaPatch(snapshot), { feedSource: 'per-mode', missingModes: ['streetcar'] });
  });

  it('dedupes an alert that appears in more than one per-mode feed by entity id', async () => {
    const { fetch } = fixtureFetch({
      [TTC_GTFS_RT_ALERTS_URL]: 500,
      [MODE.subway]: encodeFeed([{ id: 'shared', text: 'Bloor-Yonge elevator out' }, { id: 's1', text: 'Line 1 delay' }]),
      [MODE.bus]: encodeFeed([{ id: 'b1', text: '29 Dufferin detour' }]),
      [MODE.streetcar]: 500,
      [MODE.accessibility]: encodeFeed([{ id: 'shared', text: 'Bloor-Yonge elevator out' }]),
      [MODE.stops]: encodeFeed([]),
    });

    const feed = await fetchTtcAlertsFeed({ fetch });
    const ids = feed.alerts.map((alert) => alert.id);
    assert.equal(ids.filter((id) => id === 'shared').length, 1);
    assert.deepEqual(ids.sort(), ['b1', 's1', 'shared']);
  });

  it('keeps the existing failure path when the combined feed and every per-mode feed fail', async () => {
    const routes = { [TTC_GTFS_RT_ALERTS_URL]: 500 };
    for (const url of Object.values(MODE)) routes[url] = 500;
    const { fetch } = fixtureFetch(routes);

    await assert.rejects(fetchTtcAlertsFeed({ fetch }), (error) => {
      assert.equal(error.name, 'GtfsRtError');
      assert.equal(error.code, 'HTTP_ERROR');
      assert.equal(error.message, 'HTTP 500');
      return true;
    });
  });

  it('leaves the merged content clock unknown when a merged feed has no timestamp', async () => {
    const { fetch } = fixtureFetch({
      [TTC_GTFS_RT_ALERTS_URL]: 500,
      [MODE.subway]: encodeFeed([{ id: 's1', text: 'Line 1 delay' }], 1_762_500_100),
      [MODE.bus]: encodeFeed([{ id: 'b1', text: '29 Dufferin detour' }], null),
      [MODE.streetcar]: 500,
      [MODE.accessibility]: 500,
      [MODE.stops]: 500,
    });

    const feed = await fetchTtcAlertsFeed({ fetch });
    assert.deepEqual(feed.alerts.map((alert) => alert.id).sort(), ['b1', 's1']);
    assert.equal(feed.header.timestamp, null);
    assert.equal(buildTtcAlertsSnapshot(feed).header.timestamp, null);
  });

  it('gives the bundle section enough fetch time for the combined request plus the fallback', () => {
    // runSeed caps the fetch phase at the section timeout minus its publish
    // reserve. A combined request and the parallel per-mode round can each
    // run to the adapter timeout, so both must fit.
    const bundle = readFileSync(new URL('../scripts/seed-bundle-canada.mjs', import.meta.url), 'utf8');
    const line = bundle.split('\n').find((l) => l.includes("label: 'TTC-Alerts'"));
    const timeoutMs = Number(/timeoutMs: ([\d_]+)/.exec(line)[1].replaceAll('_', ''));
    assert.ok(
      timeoutMs - FETCH_PHASE_PUBLISH_RESERVE_MS >= 2 * GTFS_RT_TIMEOUT_MS,
      `TTC-Alerts timeout ${timeoutMs}ms leaves ${timeoutMs - FETCH_PHASE_PUBLISH_RESERVE_MS}ms to fetch; needs ${2 * GTFS_RT_TIMEOUT_MS}ms`,
    );
  });
});
