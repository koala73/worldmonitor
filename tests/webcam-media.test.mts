import assert from 'node:assert/strict';
import { beforeEach, afterEach, it } from 'node:test';
import { getWebcamImage } from '../server/worldmonitor/webcam/v1/get-webcam-image.ts';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
let calls: string[];
let response: () => Response | Promise<Response>;
let serial = 0;
const provider = () => ({
  webcamId: 123, status: 'active', title: 'Port camera',
  lastUpdatedOn: '2026-10-01T12:00:00Z',
  images: { current: { preview: 'https://images.windy.com/preview.jpg', thumbnail: 'https://images.windy.com/thumb.jpg' } },
  player: { day: 'https://webcams.windy.com/webcams/public/embed/player/123/day' },
  urls: { detail: 'https://www.windy.com/webcams/123' },
});
beforeEach(() => {
  calls = [];
  process.env.LOCAL_API_MODE = 'tauri-sidecar';
  process.env.WINDY_API_KEY = 'synthetic-key';
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  response = () => Response.json(provider());
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    assert.ok(url.startsWith('https://api.windy.com/webcams/api/v3/webcams/'));
    assert.equal(new URL(url).searchParams.get('include'), 'images,player,urls');
    assert.equal(new Headers(init?.headers).get('x-windy-api-key'), 'synthetic-key');
    assert.ok(new Headers(init?.headers).get('User-Agent'));
    assert.equal(init?.redirect, 'manual');
    calls.push(url);
    return response();
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});
const resolve = (id = `v3-${++serial}`) => getWebcamImage({}, { webcamId: id });

it('maps the documented Windy v3 single-camera images, player and urls fields', async () => {
  // Contract: https://api.windy.com/webcams/version-transfer (checked 2026-10-29).
  const before = Date.now();
  const media = await resolve('v3-cache');
  assert.equal(media.thumbnailUrl, provider().images.current.preview);
  assert.equal(media.playerUrl, provider().player.day);
  assert.equal(media.windyUrl, provider().urls.detail);
  assert.equal(media.lastUpdated, '2026-10-01T12:00:00.000Z');
  assert.equal(media.mediaType, 'timelapse');
  assert.equal(typeof media.resolvedAt, 'number');
  assert.ok(media.resolvedAt! >= before);
  assert.notEqual(media.lastUpdated, media.resolvedAt);
  const cached = await resolve('v3-cache');
  assert.deepEqual(cached, media, 'cache hits preserve the original resolution time');
  assert.equal(calls.length, 1, 'a second call reuses the shared cache');
});

it('uses the thumbnail fallback and identifies a snapshot without inventing a player', async () => {
  response = () => Response.json({ ...provider(), images: { current: { thumbnail: 'https://images.windy.com/small.jpg' } }, player: undefined, lastUpdatedOn: 'invalid' });
  const media = await resolve();
  assert.equal(media.thumbnailUrl, 'https://images.windy.com/small.jpg');
  assert.equal(media.playerUrl, '');
  assert.equal(media.mediaType, 'snapshot');
  assert.equal(media.lastUpdated, '', 'invalid capture dates must not become a 500 or the resolution time');
  assert.equal(calls.length, 1);
});

it('identifies a provider live player only when that property is supplied', async () => {
  response = () => Response.json({ ...provider(), player: { live: 'https://webcams.windy.com/live' } });
  const media = await resolve();
  assert.equal(media.mediaType, 'live');
  assert.equal(media.playerUrl, 'https://webcams.windy.com/live');
});

it('uses another documented timelapse timespan when day is absent', async () => {
  response = () => Response.json({ ...provider(), player: { month: 'https://webcams.windy.com/month' } });
  const media = await resolve();
  assert.equal(media.mediaType, 'timelapse');
  assert.equal(media.playerUrl, 'https://webcams.windy.com/month');
});

for (const [name, reply] of [
  ['inactive camera', () => Response.json({ ...provider(), status: 'inactive' })],
  ['missing media', () => Response.json({ title: 'No media' })],
  ['invalid media URLs', () => Response.json({ images: { current: { preview: 'javascript:alert(1)' } }, player: { day: {} } })],
  ['missing camera', () => new Response('', { status: 404 })],
  ['provider credential failure', () => new Response('', { status: 401 })],
  ['provider failure', () => new Response('', { status: 503 })],
  ['malformed JSON', () => new Response('invalid')],
  ['timeout', () => { throw new DOMException('fixture timeout', 'TimeoutError'); }],
] as const) {
  it(`returns an unavailable media result for ${name} with at most one provider request`, async () => {
    response = reply;
    const media = await resolve();
    assert.equal(media.error, 'unavailable');
    assert.equal(media.thumbnailUrl, '');
    assert.equal(media.playerUrl, '');
    assert.equal(calls.length, 1);
  });
}

it('returns unavailable without a provider call when the credential is missing', async () => {
  delete process.env.WINDY_API_KEY;
  assert.equal((await resolve()).error, 'unavailable');
  assert.equal(calls.length, 0);
});
