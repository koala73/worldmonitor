import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { listNavigationalWarnings } from '../server/worldmonitor/maritime/v1/list-navigational-warnings.ts';

const originalFetch = globalThis.fetch;
const ENV_KEYS = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'WS_RELAY_URL'] as const;
const originalEnv = new Map<string, string | undefined>();

function redisHarness(externalFetch: (url: string) => Promise<Response>) {
  const values = new Map<string, string>();
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.startsWith('https://redis.test/get/')) {
      const key = decodeURIComponent(new URL(url).pathname.slice('/get/'.length));
      return Response.json({ result: values.get(key) ?? null });
    }
    if (url === 'https://redis.test/') {
      const command = JSON.parse(String(init?.body || '[]')) as unknown[];
      if (command[0] === 'SET') {
        values.set(String(command[1]), String(command[2]));
        return Response.json({ result: 'OK' });
      }
      return Response.json({ result: null });
    }
    return externalFetch(url);
  };
  return { fetchImpl };
}

function warning(issueDate: string) {
  return {
    msgYear: 2024,
    msgNumber: 8,
    navArea: 'IV',
    text: 'HAZARD',
    issueDate,
    authority: 'NAVAREA IV',
  };
}

async function issuedAtFor(issueDate: string): Promise<number> {
  const harness = redisHarness(async (url) => {
    assert.match(url, /msi\.nga\.mil\/api\/publications\/broadcast-warn/);
    return Response.json({ 'broadcast-warn': [warning(issueDate)] });
  });
  globalThis.fetch = harness.fetchImpl as typeof fetch;
  const response = await listNavigationalWarnings({} as never, { area: '', pageSize: 0, cursor: '' });
  assert.equal(response.warnings.length, 1);
  return response.warnings[0]!.issuedAt;
}

beforeEach(() => {
  for (const key of ENV_KEYS) originalEnv.set(key, process.env[key]);
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  process.env.WS_RELAY_URL = 'https://relay.test';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv.clear();
});

describe('navigational warning issue dates', () => {
  it('parses a valid NGA month token as UTC', async () => {
    const issuedAt = await issuedAtFor('081653Z MAY 2024');

    assert.equal(issuedAt, Date.UTC(2024, 4, 8, 16, 53));
    assert.equal(new Date(issuedAt).toISOString(), '2024-05-08T16:53:00.000Z');
  });

  it('parses January, whose month index is 0', async () => {
    const issuedAt = await issuedAtFor('081653Z JAN 2024');

    assert.equal(issuedAt, Date.UTC(2024, 0, 8, 16, 53));
  });

  it('returns the invalid-date sentinel for an unknown month token', async () => {
    const issuedAt = await issuedAtFor('081653Z XYZ 2024');

    assert.equal(issuedAt, 0);
  });
});
