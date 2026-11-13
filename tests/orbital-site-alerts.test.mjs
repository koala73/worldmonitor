import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  CHANGE_COOLDOWN_MS,
  IMAGING_WINDOW_EVENT_TYPE,
  SITE_CHANGE_EVENT_TYPE,
  WINDOW_COOLDOWN_MS,
  publishOrbitalSiteAlerts,
} = require('../scripts/lib/orbital-site-alerts.cjs');

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

const window = (noradId, offsetMs, category = 'open-optical') => ({
  noradId, name: `SAT-${noradId}`, profileId: 'sentinel-2', category, time: iso(NOW + offsetMs), sunElevationDeg: 40,
});
const flagWith = (...events) => ({ siteId: 'site-a', state: events.at(-1)?.kind ?? 'monitoring', events });
const confirmed = (itemId, atMs = NOW - HOUR) => ({ kind: 'confirmed', itemId, datetime: iso(atMs), platform: 'sentinel-1a' });
const raised = (itemId, atMs = NOW - HOUR) => ({ kind: 'raised', itemId, datetime: iso(atMs), platform: 'sentinel-1a' });
const site = (siteId, { nextWindows = [], flag = null } = {}) => ({ siteId, name: `Site ${siteId}`, nextWindows, flag });

function harness({ publishResult = () => true } = {}) {
  let stored = null;
  const published = [];
  const writes = [];
  return {
    published,
    writes,
    get state() { return stored; },
    run(records, { shadow = false, now = NOW } = {}) {
      return publishOrbitalSiteAlerts(records, {
        shadow,
        now: () => now,
        readState: async () => (stored ? JSON.parse(JSON.stringify(stored)) : null),
        writeState: async (_key, state) => { stored = JSON.parse(JSON.stringify(state)); writes.push(stored); return true; },
        publish: async (event) => { published.push(event); return publishResult(event); },
      });
    },
  };
}

describe('confirmed-change alerts', () => {
  it('a flag moving to confirmed emits one event, and a second run in the same state emits none', async () => {
    const h = harness();
    await h.run([site('site-a', { flag: flagWith(raised('scene-1', NOW - 2 * HOUR)) })]);
    assert.equal(h.published.length, 0, 'raised flag stays quiet');
    const record = site('site-a', { flag: flagWith(raised('scene-1', NOW - 2 * HOUR), confirmed('scene-2')) });
    await h.run([record]);
    assert.equal(h.published.length, 1);
    assert.equal(h.published[0].eventType, SITE_CHANGE_EVENT_TYPE);
    assert.equal(h.published[0].payload.siteId, 'site-a');
    assert.equal(h.published[0].payload.coalesceKey, 'orbital_site_change:site-a:scene-2');
    await h.run([record], { now: NOW + 3 * CHANGE_COOLDOWN_MS });
    assert.equal(h.published.length, 1, 'same confirmed state on a later run');
  });

  it('a raised flag emits nothing', async () => {
    const h = harness();
    await h.run([site('site-a', { flag: flagWith(raised('scene-1')) })]);
    assert.deepEqual(h.published, []);
  });

  it('while change scoring is shadowed, a confirmed flag emits nothing and leaves no answered state', async () => {
    const h = harness();
    const record = site('site-a', { flag: flagWith(confirmed('scene-2')) });
    await h.run([record], { shadow: true });
    assert.deepEqual(h.published, []);
    assert.equal(h.state?.['site-a']?.change, undefined);
  });

  it('requires an explicit shadow switch', async () => {
    await assert.rejects(
      publishOrbitalSiteAlerts([site('site-a')], { now: () => NOW, readState: async () => null, writeState: async () => true, publish: async () => true }),
      /explicit shadow switch/,
    );
  });

  it('a confirmation older than a week is history and never pages', async () => {
    const h = harness();
    await h.run([site('site-a', { flag: flagWith(confirmed('scene-old', NOW - 8 * 24 * HOUR)) })]);
    assert.deepEqual(h.published, []);
  });

  it('a second confirmation inside the cooldown is absorbed, and one after it fires', async () => {
    const h = harness();
    await h.run([site('site-a', { flag: flagWith(confirmed('scene-2')) })]);
    await h.run([site('site-a', { flag: flagWith(confirmed('scene-2'), confirmed('scene-3', NOW + HOUR)) })], { now: NOW + 2 * HOUR });
    assert.equal(h.published.length, 1, 'cooldown');
    const later = NOW + CHANGE_COOLDOWN_MS + 2 * HOUR;
    await h.run([site('site-a', { flag: flagWith(confirmed('scene-3', NOW + HOUR), confirmed('scene-4', later - HOUR)) })], { now: later });
    assert.equal(h.published.length, 2);
    assert.equal(h.published[1].payload.itemId, 'scene-4');
  });

  it('a failed publish keeps the event pending and retries it with the same coalesce key', async () => {
    let fail = true;
    const h = harness({ publishResult: () => !fail });
    const record = site('site-a', { flag: flagWith(confirmed('scene-2')) });
    await h.run([record]);
    assert.ok(h.writes[0]['site-a'].change.pending, 'pending persisted before publish');
    fail = false;
    await h.run([record], { now: NOW + HOUR });
    assert.equal(h.published.length, 2);
    assert.equal(h.published[0].payload.coalesceKey, h.published[1].payload.coalesceKey);
    await h.run([record], { now: NOW + 2 * HOUR });
    assert.equal(h.published.length, 2, 'fired once queued');
  });
});

describe('imaging-window alerts', () => {
  it('coalesces every new open window of a site into one event per run', async () => {
    const h = harness();
    await h.run([site('site-a', { nextWindows: [window(1, 2 * HOUR), window(2, 5 * HOUR, 'open-radar'), window(3, 30 * HOUR)] })]);
    assert.equal(h.published.length, 1);
    const [event] = h.published;
    assert.equal(event.eventType, IMAGING_WINDOW_EVENT_TYPE);
    assert.deepEqual(event.payload.windows.map((w) => w.noradId), [1, 2], 'windows past the lead horizon wait');
    assert.equal(event.payload.coalesceKey, `orbital_imaging_window:site-a:${iso(NOW + 2 * HOUR)}`);
  });

  it('alerts for open optical and radar sensors only', async () => {
    const h = harness();
    await h.run([site('site-a', { nextWindows: [window(1, HOUR, 'commercial-optical'), window(2, 2 * HOUR, 'weather')] })]);
    assert.deepEqual(h.published, []);
  });

  it('a window alerts once, and new windows wait out the cooldown', async () => {
    const h = harness();
    const first = window(1, 20 * HOUR);
    await h.run([site('site-a', { nextWindows: [first] })]);
    await h.run([site('site-a', { nextWindows: [first, window(2, 22 * HOUR)] })], { now: NOW + HOUR });
    assert.equal(h.published.length, 1, 'cooldown holds the second window');
    await h.run([site('site-a', { nextWindows: [first, window(2, 22 * HOUR)] })], { now: NOW + WINDOW_COOLDOWN_MS + HOUR });
    assert.equal(h.published.length, 2);
    assert.deepEqual(h.published[1].payload.windows.map((w) => w.noradId), [2], 'the first window is not repeated');
  });

  it('drops a pending event once its passes have ended and alerts for the new ones', async () => {
    let fail = true;
    const h = harness({ publishResult: () => !fail });
    await h.run([site('site-a', { nextWindows: [window(1, HOUR)] })]);
    fail = false;
    const nextDay = NOW + 24 * HOUR;
    await h.run([site('site-a', { nextWindows: [{ ...window(2, 0), time: iso(nextDay + 2 * HOUR) }] })], { now: nextDay });
    assert.equal(h.published.length, 2);
    assert.deepEqual(h.published[1].payload.windows.map((w) => w.noradId), [2], 'the ended pass is not sent as upcoming');
  });

  it('asks the queue publisher to hold its dedup for the producer window', async () => {
    const h = harness();
    await h.run([site('site-a', { nextWindows: [window(1, HOUR)], flag: flagWith(confirmed('scene-2')) })]);
    for (const event of h.published) assert.equal(event.cooldownSeconds, 7 * 24 * 60 * 60, event.eventType);
  });

  it('keeps each site separate', async () => {
    const h = harness();
    await h.run([site('site-a', { nextWindows: [window(1, HOUR)] }), site('site-b', { nextWindows: [window(1, HOUR)] })]);
    assert.deepEqual(h.published.map((e) => e.payload.siteId), ['site-a', 'site-b']);
    assert.notEqual(h.published[0].payload.coalesceKey, h.published[1].payload.coalesceKey);
  });

  it('publishes nothing when the state cannot be read', async () => {
    const published = [];
    const result = await publishOrbitalSiteAlerts([site('site-a', { nextWindows: [window(1, HOUR)] })], {
      shadow: false,
      now: () => NOW,
      readState: async (_key, onError) => { onError(); return null; },
      writeState: async () => true,
      publish: async (event) => { published.push(event); return true; },
    });
    assert.equal(result, null);
    assert.deepEqual(published, []);
  });
});
