import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';

const originalWidgetKey = process.env.WIDGET_AGENT_KEY;
const originalProKey = process.env.PRO_WIDGET_KEY;
const originalValidKeys = process.env.WORLDMONITOR_VALID_KEYS;

function fakeRelayResponse(
  body = 'data: {"type":"done"}\n\n',
  status = 200,
  contentType = 'text/event-stream',
): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': contentType },
  });
}

describe('widget-agent unified tester key auth', () => {
  let handler: (req: Request) => Promise<Response>;
  let fetchMock: ReturnType<typeof mock.method<typeof globalThis, 'fetch'>>;

  before(async () => {
    process.env.WIDGET_AGENT_KEY = 'server-widget-key';
    process.env.PRO_WIDGET_KEY = 'server-pro-key';
    process.env.WORLDMONITOR_VALID_KEYS = 'browser-test-key';

    fetchMock = mock.method(globalThis, 'fetch', () => Promise.resolve(fakeRelayResponse()));
    ({ default: handler } = await import('../api/widget-agent.ts'));
  });

  beforeEach(() => {
    fetchMock.mock.resetCalls();
    fetchMock.mock.mockImplementation(() => Promise.resolve(fakeRelayResponse()));
  });

  after(() => {
    fetchMock.mock.restore();

    if (originalWidgetKey == null) delete process.env.WIDGET_AGENT_KEY;
    else process.env.WIDGET_AGENT_KEY = originalWidgetKey;

    if (originalProKey == null) delete process.env.PRO_WIDGET_KEY;
    else process.env.PRO_WIDGET_KEY = originalProKey;

    if (originalValidKeys == null) delete process.env.WORLDMONITOR_VALID_KEYS;
    else process.env.WORLDMONITOR_VALID_KEYS = originalValidKeys;
  });

  it('accepts X-WorldMonitor-Key and upgrades relay request to pro', async () => {
    const res = await handler(new Request('https://www.worldmonitor.app/api/widget-agent', {
      method: 'POST',
      headers: {
        Origin: 'https://www.worldmonitor.app',
        'Content-Type': 'application/json',
        'X-WorldMonitor-Key': 'browser-test-key',
      },
      body: JSON.stringify({ prompt: 'Build a widget', mode: 'create', tier: 'basic' }),
    }));

    assert.equal(res.status, 200);
    assert.equal(fetchMock.mock.calls.length, 1);

    const call = fetchMock.mock.calls[0];
    assert.equal(call.arguments[0], 'https://proxy.worldmonitor.app/widget-agent');

    const init = call.arguments[1] as RequestInit;
    const headers = new Headers(init.headers);
    assert.equal(headers.get('X-Widget-Key'), 'server-widget-key');
    assert.equal(headers.get('X-Pro-Key'), 'server-pro-key');
    assert.equal(headers.get('X-WorldMonitor-Key'), null);

    assert.deepEqual(JSON.parse(String(init.body)), {
      prompt: 'Build a widget',
      mode: 'create',
      tier: 'pro',
    });
  });

  it('rejects invalid X-WorldMonitor-Key before relay fetch', async () => {
    const res = await handler(new Request('https://www.worldmonitor.app/api/widget-agent', {
      method: 'POST',
      headers: {
        Origin: 'https://www.worldmonitor.app',
        'Content-Type': 'application/json',
        'X-WorldMonitor-Key': 'wrong-key',
      },
      body: JSON.stringify({ prompt: 'Build a widget', mode: 'create', tier: 'pro' }),
    }));

    assert.equal(res.status, 403);
    assert.equal(fetchMock.mock.calls.length, 0);

    const body = await res.json() as { error: string };
    assert.equal(body.error, 'Forbidden');
  });
});
