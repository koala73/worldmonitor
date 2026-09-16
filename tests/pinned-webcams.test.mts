import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { normalizePinnedWebcam, resolveWebcamPlayerUrl, normalizePinnedWebcamsPreference, MAX_PINNED_WEBCAMS_BYTES } from '../shared/pinned-webcams.ts';
import { getPinnedWebcams, getActiveWebcams, pinWebcam, toggleWebcam, unpinWebcam } from '../src/services/webcams/pinned-store.ts';

const base = 'https://webcams.windy.com/webcams/public/embed/player';
const fixture = { webcamId: '123', title: 'Test camera', lat: 25, lng: 55, category: 'city', country: 'AE', playerUrl: '', active: true, pinnedAt: 1 };
const savedGlobals = new Map(['localStorage', 'requestAnimationFrame', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let raw: string | null = null;
let nextFrame: (() => void) | undefined;
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; } } });
Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: () => void) => { nextFrame = callback; return 1; } });
Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
beforeEach(() => { nextFrame?.(); nextFrame = undefined; raw = null; });
after(() => { for (const [key, descriptor] of savedGlobals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });

test('preserves Windy path and query player variants and options', () => {
  for (const period of ['day', 'month', 'year', 'lifetime', 'live']) {
    for (const url of [`${base}/123/${period}?autoplay=1&token=example`, `${base}?webcamId=123&playerType=${period}&interactive=true`]) {
      assert.equal(resolveWebcamPlayerUrl('123', url), url);
    }
  }
  assert.equal(resolveWebcamPlayerUrl('123', `${base}?webcamId=123`), `${base}?webcamId=123`);
});

test('rejects unsafe destinations, endpoint confusion and mismatched IDs with a known fallback', () => {
  for (const url of [
    'javascript:parent.__webcamCanary=true', 'data:text/html,canary', 'blob:https://worldmonitor.app/canary',
    '/dashboard', '//webcams.windy.com/webcams/public/embed/player/123/day',
    'https://worldmonitor.app/dashboard', 'https://www.youtube.com/embed/test',
    `http://webcams.windy.com/webcams/public/embed/player/123/day`,
    `${base.replace('webcams.windy.com', 'webcams.windy.com.evil.example')}/123/day`,
    `${base.replace('webcams.windy.com', 'user:pass@webcams.windy.com')}/123/day`,
    `${base.replace('webcams.windy.com', 'webcams.windy.com:444')}/123/day`,
    `${base}/123/day/extra`, `${base}/123/../../admin`, `${base}/123/%64ay`,
    `${base}/other/day`, `${base}/123/week`, `${base}?webcamId=other`,
    `${base}?webcamId=123&webcamId=other`, `${base}?webcamId=123&playerType=bad`,
    `${base}?webcamId=123&playerType=month%0A`,
    `${base}-redirect?webcamId=123`, `${base}/123/day?webcamId=other`,
    '', null, undefined, {}, 1,
  ]) assert.equal(resolveWebcamPlayerUrl('123', url), `${base}/123/day`, String(url));
  for (const id of ['', '../x', 'a/b', 'x?foo=1', 'x'.repeat(65), '123\n']) assert.equal(resolveWebcamPlayerUrl(id, ''), null);
});

test('validates record fields, drops extra fields, and preserves missing-URL fallback', () => {
  assert.deepEqual(normalizePinnedWebcam({ ...fixture, extra: true }), { ...fixture, playerUrl: `${base}/123/day` });
  const { playerUrl: _url, ...missingUrl } = fixture;
  assert.equal(normalizePinnedWebcam(missingUrl)?.playerUrl, `${base}/123/day`);
  for (const value of [null, [], {}, 4, 'camera',
    ...Object.keys(fixture).map(key => ({ ...fixture, [key]: null })),
    { ...fixture, lat: 91 }, { ...fixture, lng: -181 }, { ...fixture, lat: NaN },
    { ...fixture, pinnedAt: Infinity }, { ...fixture, pinnedAt: -1 },
    { ...fixture, active: 'true' }, { ...fixture, webcamId: '../bad' },
  ]) assert.equal(normalizePinnedWebcam(value), null, JSON.stringify(value));
});

test('direct storage restores normalize legacy records idempotently', () => {
  for (const payload of ['null', '{}', '42', '"text"', '{broken', '[null,{},false]']) {
    nextFrame?.(); raw = payload;
    assert.deepEqual(getPinnedWebcams(), []);
    assert.deepEqual(getActiveWebcams(), []);
    assert.equal(raw, '[]');
  }
  nextFrame?.();
  raw = JSON.stringify([null, fixture, { ...fixture, webcamId: '456', playerUrl: 'javascript:parent.__webcamCanary=true' }]);
  assert.deepEqual(getActiveWebcams().map(cam => cam.playerUrl), [`${base}/123/day`, `${base}/456/day`]);
  assert.ok(!raw.includes('javascript:'));
  const normalized = raw;
  nextFrame?.();
  getPinnedWebcams();
  assert.equal(raw, normalized);
});

test('bounds serialized bytes, unique records and active streams', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ ...fixture, webcamId: String(i), pinnedAt: i }));
  const raw = normalizePinnedWebcamsPreference(JSON.stringify([rows[0], ...rows]));
  const parsed = JSON.parse(raw);
  assert.equal(parsed.length, 32);
  assert.equal(parsed.filter((cam: typeof fixture) => cam.active).length, 4);
  assert.equal(normalizePinnedWebcamsPreference(raw), raw);
  for (const value of [null, {}, [], 3, 'null', '{}', '[', ' '.repeat(MAX_PINNED_WEBCAMS_BYTES + 1), JSON.stringify([{ ...fixture, title: '🌍'.repeat(5000) }])]) {
    assert.equal(normalizePinnedWebcamsPreference(value), '[]');
  }
  assert.ok(Buffer.byteLength(raw) <= MAX_PINNED_WEBCAMS_BYTES);
});

test('keeps validated reads when legacy storage repair is rejected', () => {
  raw = JSON.stringify([{ ...fixture, playerUrl: 'javascript:canary' }]);
  const setItem = localStorage.setItem;
  localStorage.setItem = () => { throw new Error('Storage full'); };
  try {
    assert.equal(getPinnedWebcams()[0]?.playerUrl, `${base}/123/day`);
    assert.ok(raw.includes('javascript:'));
  } finally {
    localStorage.setItem = setItem;
  }
});

test('pin validates provider data and retains toggle, limit and removal behavior', () => {
  pinWebcam({ ...fixture, webcamId: '../bad' });
  assert.equal(raw, null);
  for (let i = 1; i <= 5; i++) pinWebcam({ ...fixture, webcamId: String(i), playerUrl: 'https://example.org/not-a-player' });
  assert.equal(getPinnedWebcams().length, 5);
  assert.equal(getActiveWebcams().length, 4);
  assert.ok(JSON.parse(raw!).every((cam: typeof fixture) => cam.playerUrl === `${base}/${cam.webcamId}/day`));
  toggleWebcam('5');
  assert.equal(getActiveWebcams().length, 4);
  assert.ok(getActiveWebcams().some(cam => cam.webcamId === '5'));
  unpinWebcam('5');
  assert.equal(getPinnedWebcams().length, 4);
});
