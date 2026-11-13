import { afterEach, expect, test, vi } from "vitest";
import http from "../http";

const handler = (http.lookup('/relay/intel-history', 'POST')![0] as unknown as {
  _handler: (ctx: unknown, request: Request) => Promise<Response>;
})._handler;
const body = { domain: 'conflict', resource: 'test', runId: 'private-run', records: [{
  dedupeKey: 'private-key', title: 'private-title', occurredAt: 1,
  embedding: Array(512).fill(0),
}] };
function setup() {
  vi.stubEnv('RELAY_SHARED_SECRET', 'private-secret');
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  const events = () => log.mock.calls.map(([line]) => JSON.parse(String(line)));
  const request = new Request('https://convex.test/relay/intel-history', {
    method: 'POST', headers: { Authorization: 'Bearer private-secret' }, body: JSON.stringify(body),
  });
  return { log, events, request };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

test('history phases distinguish pending body and pending mutation without logging input', async () => {
  const { events, request, log } = setup();
  let now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  let releaseBody!: (value: unknown) => void;
  const read = vi.spyOn(request, 'json').mockImplementation(() => new Promise(resolve => { releaseBody = resolve; }));
  let releaseMutation!: (value: unknown) => void;
  const runMutation = vi.fn(() => new Promise(resolve => { releaseMutation = resolve; }));
  const result = handler({ runMutation }, request);
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  expect(events().map(e => e.phase)).toEqual(['handler_enter', 'auth_complete']);
  now = 1100;
  releaseBody(body);
  await vi.waitFor(() => expect(runMutation).toHaveBeenCalledOnce());
  expect(events().map(e => e.phase)).toEqual(['handler_enter', 'auth_complete', 'body_complete', 'validation_complete', 'mutation_started']);
  now = 1300;
  releaseMutation({ inserted: 1, skipped: 0, retracted: 0 });
  const response = await result;
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ inserted: 1, skipped: 0, retracted: 0 });
  expect(events().slice(-2)).toEqual([
    { event: 'intel_history_phase', phase: 'mutation_complete', elapsedMs: 300 },
    { event: 'intel_history_phase', phase: 'response_ready', elapsedMs: 300, status: 200 },
  ]);
  expect(events().find(e => e.phase === 'body_complete').elapsedMs).toBe(100);
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-|embedding|Authorization/);
});

test('history rejection records response status without reading unauthorized bodies', async () => {
  const { request, events } = setup();
  request.headers.set('Authorization', 'Bearer wrong');
  const read = vi.spyOn(request, 'json');
  const runMutation = vi.fn();
  expect((await handler({ runMutation }, request)).status).toBe(401);
  expect(read).not.toHaveBeenCalled();
  expect(runMutation).not.toHaveBeenCalled();
  expect(events().at(-1)).toMatchObject({ phase: 'response_ready', status: 401 });
});

test('history mutation failure preserves response and emits only a fixed failure phase', async () => {
  const { request, events, log } = setup();
  const response = await handler({ runMutation: async () => { throw new Error('private-error'); } }, request);
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: 'private-error' });
  expect(events().slice(-2).map(e => e.phase)).toEqual(['mutation_failed', 'response_ready']);
  expect(JSON.stringify(log.mock.calls)).not.toContain('private-error');
});

test.each(['invalid-json', 'invalid-record'] as const)('history %s rejection never starts a mutation', async (kind) => {
  const { request, events } = setup();
  vi.spyOn(request, 'json').mockImplementation(async () => {
    if (kind === 'invalid-json') throw new SyntaxError('private-parser-detail');
    return { ...body, records: [{ ...body.records[0], embedding: [] }] };
  });
  const runMutation = vi.fn();
  const response = await handler({ runMutation }, request);
  expect(response.status).toBe(400);
  expect((await response.json()).error).toBe(kind === 'invalid-json' ? 'INVALID_JSON' : 'INVALID_RECORD');
  expect(runMutation).not.toHaveBeenCalled();
  expect(events().map(e => e.phase)).toEqual(['handler_enter', 'auth_complete', 'body_complete', 'response_ready']);
  expect(events().at(-1)).toMatchObject({ status: 400 });
});
