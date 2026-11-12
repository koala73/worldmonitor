import { test, expect, type Page } from '@playwright/test';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { PRO_BEARER } from '../tests/helpers/mcp-pro-deps.mjs';

// Browser HTTP -> real MCP -> HTTP -> generated WebcamService routes.
// Identity/entitlement/quota storage, Redis and Windy use controlled fixtures.
// The separate server process uses TSX without interfering with Playwright's loader.
let server: ChildProcess;
let origin = '';
type ServerState = { origin: string; providerCalls: number; routeCalls: string[] };
async function control(action: string): Promise<ServerState> {
  const reply = once(server, 'message');
  server.send(action);
  return (await reply)[0];
}

test.beforeAll(async () => {
  server = fork(new URL('../tests/helpers/webcam-mcp-browser-server.mts', import.meta.url), {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  server.stderr?.on('data', chunk => process.stderr.write(chunk));
  const ready = await Promise.race([
    once(server, 'message'),
    once(server, 'exit').then(([code]) => { throw new Error(`Webcam fixture server exited before readiness: ${code}`); }),
  ]);
  origin = (ready[0] as ServerState).origin;
});
test.beforeEach(async ({ page }) => {
  await control('reset');
  await page.goto(origin);
});
test.afterAll(async () => {
  if (!server || server.exitCode !== null) return;
  const stopped = once(server, 'exit');
  server.kill('SIGTERM');
  await stopped;
});

const camera = { webcamId: '123', title: 'Synthetic port camera', lat: 51.5, lng: 4.5, category: 'harbor', country: 'NL' };
const bounds = { bound_w: 4, bound_s: 51, bound_e: 5, bound_n: 52, zoom: 9, limit: 1 };
const provider = {
  webcamId: 123, status: 'active', title: camera.title, lastUpdatedOn: '2026-10-01T12:00:00Z',
  images: { current: { preview: 'https://images.windy.com/fixture.jpg' } },
  player: { day: 'https://webcams.windy.com/webcams/public/embed/player/123/day' },
  urls: { detail: 'https://www.windy.com/webcams/123' },
};

async function rpc(page: Page, method: string, params: Record<string, unknown>, authenticated = true) {
  return page.evaluate(async ({ method, params, token }) => {
    const response = await fetch('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2025-03-26', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return { status: response.status, body: await response.json() };
  }, { method, params, token: authenticated ? PRO_BEARER : '' });
}

test('discovers and resolves one webcam through browser HTTP with capture, resolution and attribution intact', async ({ page }, testInfo) => {
  const init = await rpc(page, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'webcam-browser-test', version: '1' } });
  expect(init.status).toBe(200);
  expect(init.body.result.capabilities.tools).toBeDefined();
  const listed = await rpc(page, 'tools/list', {});
  expect(listed.status).toBe(200);
  expect(listed.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(['find_webcams', 'get_webcam_media']));
  const discovered = await rpc(page, 'tools/call', { name: 'find_webcams', arguments: bounds });
  expect(discovered.status).toBe(200);
  expect(discovered.body.result.structuredContent).toMatchObject({ state: 'available', webcams: [camera], catalog: { stale: false } });
  expect((await control('stats')).providerCalls).toBe(0);
  const webcamId = discovered.body.result.structuredContent.webcams[0].webcamId;
  const resolved = await rpc(page, 'tools/call', { name: 'get_webcam_media', arguments: { webcam_id: webcamId } });
  expect(resolved.status).toBe(200);
  const media = resolved.body.result.structuredContent;
  expect(media).toMatchObject({ state: 'available', lastUpdated: '2026-10-01T12:00:00.000Z', playerUrl: provider.player.day, thumbnailUrl: provider.images.current.preview });
  expect(Date.parse(media.refreshAfter) - Date.parse(media.resolvedAt)).toBe(300_000);
  expect((await control('stats')).providerCalls).toBe(1);
  const rest = await page.evaluate(async () => (await fetch('/api/webcam/v1/get-webcam-image?webcam_id=123')).json());
  expect(typeof rest.resolvedAt).toBe('number');
  expect(rest.resolvedAt).toBe(Date.parse(media.resolvedAt));
  const projected = await rpc(page, 'tools/call', { name: 'get_webcam_media', arguments: { webcam_id: webcamId, jmespath: '{image: thumbnailUrl, resolved: resolvedAt}' } });
  expect(projected.body.result.structuredContent).toMatchObject({ data: { image: media.thumbnailUrl, resolved: media.resolvedAt }, _attribution: { required: true, sources: [{ url: provider.urls.detail }] } });
  expect((await control('stats')).providerCalls).toBe(1);
  expect((await control('stats')).routeCalls).toEqual(['/api/webcam/v1/list-webcams', ...Array(3).fill('/api/webcam/v1/get-webcam-image')]);
  await testInfo.attach('webcam-mcp-http-results.json', { body: JSON.stringify({ discovered: discovered.body, resolved: resolved.body, rest, projected: projected.body, ...(await control('stats')) }, null, 2), contentType: 'application/json' });
});

test('keeps unavailable media, invalid arguments and authentication failures distinct in the browser', async ({ page }) => {
  const params = { name: 'get_webcam_media', arguments: { webcam_id: camera.webcamId } };
  const unauthorized = await rpc(page, 'tools/call', params, false);
  expect(unauthorized.status).toBe(401);
  const invalid = await rpc(page, 'tools/call', { name: 'find_webcams', arguments: { ...bounds, bound_s: 53 } });
  expect(invalid.body.error).toBeDefined();
  expect((await control('stats')).routeCalls).toHaveLength(0);
  await control('missing-key');
  const missingKey = await rpc(page, 'tools/call', params);
  expect(missingKey.body.result.structuredContent).toMatchObject({ state: 'unavailable', reason: 'media_unavailable', thumbnailUrl: '' });
  expect((await control('stats')).providerCalls).toBe(0);
  await control('restore-key');
  await control('missing-catalog');
  const missingCatalog = await rpc(page, 'tools/call', { name: 'find_webcams', arguments: bounds });
  expect(missingCatalog.body.result.structuredContent).toMatchObject({ state: 'unavailable', reason: 'catalog_unavailable' });
  await control('restore-catalog');
  await control('provider-failure');
  const failed = await rpc(page, 'tools/call', params);
  expect(failed.body.result.structuredContent).toMatchObject({ state: 'unavailable', reason: 'media_unavailable' });
  expect((await control('stats')).providerCalls).toBe(1);
  await control('expired-media');
  const expired = await rpc(page, 'tools/call', params);
  expect(expired.body.result.structuredContent).toMatchObject({ state: 'unavailable', reason: 'media_expired', thumbnailUrl: '' });
  expect((await control('stats')).providerCalls).toBe(1);
});
