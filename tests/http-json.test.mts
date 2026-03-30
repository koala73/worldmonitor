import assert from 'node:assert/strict';
import test from 'node:test';

import { readJsonResponse } from '../src/utils/http-json';

test('readJsonResponse parses valid JSON responses', async () => {
  const response = new Response(JSON.stringify({ ok: true, count: 2 }), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

  const result = await readJsonResponse<{ ok: boolean; count: number }>(
    response,
    'Fallback unavailable',
  );

  assert.deepEqual(result, { ok: true, count: 2 });
});

test('readJsonResponse still parses valid JSON when content-type is missing', async () => {
  const response = new Response(JSON.stringify({ status: 'ok' }));

  const result = await readJsonResponse<{ status: string }>(
    response,
    'Fallback unavailable',
  );

  assert.deepEqual(result, { status: 'ok' });
});

test('readJsonResponse converts html error pages into a calm fallback error', async () => {
  const response = new Response('<!DOCTYPE html><html><body>Not found</body></html>', {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

  await assert.rejects(
    () => readJsonResponse(response, 'Data unavailable right now'),
    /Data unavailable right now/,
  );
});

test('readJsonResponse converts malformed json into a calm fallback error', async () => {
  const response = new Response('{not-json', {
    headers: { 'content-type': 'application/json' },
  });

  await assert.rejects(
    () => readJsonResponse(response, 'Data unavailable right now'),
    /Data unavailable right now/,
  );
});
