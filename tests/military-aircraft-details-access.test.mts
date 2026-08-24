import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { getAircraftDetails } from '../server/worldmonitor/military/v1/get-aircraft-details.ts';
import {
  ENDPOINT_RATE_POLICIES,
  FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED,
} from '../server/_shared/rate-limit.ts';
import { PREMIUM_RPC_PATHS } from '../src/shared/premium-paths.ts';

const AIRCRAFT_DETAILS_PATH = '/api/military/v1/get-aircraft-details';
const BATCH_PATH = '/api/military/v1/get-aircraft-details-batch';
const API_KEY = 'test-enterprise-key';
const ENV_KEYS = ['WINGBITS_API_KEY', 'WORLDMONITOR_VALID_KEYS'] as const;
const originalEnv = new Map<string, string | undefined>();
const originalFetch = globalThis.fetch;
const serviceSource = readFileSync(resolve(import.meta.dirname, '../src/services/wingbits.ts'), 'utf8');

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
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

function ctx(headers: Record<string, string> = {}) {
  return {
    request: new Request(`https://api.worldmonitor.app${AIRCRAFT_DETAILS_PATH}?icao24=a835af`, { headers }),
    pathParams: {},
    headers: {},
  };
}

describe('Wingbits aircraft-details access contract', () => {
  it('uses the same 30/min fail-closed policy as the batch route', () => {
    assert.deepEqual(ENDPOINT_RATE_POLICIES[AIRCRAFT_DETAILS_PATH], { limit: 30, window: '60 s' });
    assert.equal(
      FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED[AIRCRAFT_DETAILS_PATH]?.reason,
      'Single aircraft enrichment proxies the external Wingbits provider on cache miss.',
    );
    assert.deepEqual(ENDPOINT_RATE_POLICIES[BATCH_PATH], { limit: 30, window: '60 s' });
  });

  it('requires identity before an anonymous request can reach Wingbits', async () => {
    process.env.WINGBITS_API_KEY = 'test-wingbits-key';
    globalThis.fetch = async () => {
      throw new Error('anonymous aircraft-details request reached a downstream fetch');
    };

    await assert.rejects(
      () => getAircraftDetails(ctx(), { icao24: 'a835af' }),
      (error: unknown) => {
        const status = (error as { statusCode?: number }).statusCode;
        assert.equal(status, 403);
        return true;
      },
    );
  });

  it('keeps an API-key caller working and forwards the Wingbits credential upstream', async () => {
    process.env.WINGBITS_API_KEY = 'test-wingbits-key';
    process.env.WORLDMONITOR_VALID_KEYS = API_KEY;
    const calls: Array<{ url: string; apiKey: string | null }> = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, apiKey: new Headers(init?.headers).get('x-api-key') });
      assert.match(url, /customer-api\.wingbits\.com\/v1\/flights\/details\/a835af$/);
      return Response.json({
        registration: 'N123WM',
        manufacturerName: 'World Monitor Aerospace',
        model: 'WM-1',
      });
    };

    const response = await getAircraftDetails(ctx({ 'X-WorldMonitor-Key': API_KEY }), { icao24: 'a835af' });

    assert.equal(response.configured, true);
    assert.equal(response.details?.registration, 'N123WM');
    assert.deepEqual(calls, [{
      url: 'https://customer-api.wingbits.com/v1/flights/details/a835af',
      apiKey: 'test-wingbits-key',
    }]);
  });

  it('rejects non-ICAO input before a paid cache miss', async () => {
    process.env.WINGBITS_API_KEY = 'test-wingbits-key';
    process.env.WORLDMONITOR_VALID_KEYS = API_KEY;
    globalThis.fetch = async () => {
      throw new Error('invalid aircraft-details input reached a downstream fetch');
    };

    await assert.rejects(
      () => getAircraftDetails(ctx({ 'X-WorldMonitor-Key': API_KEY }), { icao24: 'not-an-icao24' }),
      (error: unknown) => {
        const typed = error as { statusCode?: number; message?: string };
        assert.equal(typed.statusCode, 400);
        assert.equal(typed.message, 'icao24 must be a 6-character hexadecimal address');
        return true;
      },
    );
  });

  it('registers only the singular route for premium browser credential injection', () => {
    assert.equal(PREMIUM_RPC_PATHS.has(AIRCRAFT_DETAILS_PATH), true);
    assert.equal(PREMIUM_RPC_PATHS.has(BATCH_PATH), false);
    assert.match(serviceSource, /import \{ premiumFetch \} from '@\/services\/premium-fetch';/);
    assert.match(serviceSource, /new MilitaryServiceClient\(getRpcBaseUrl\(\), \{ fetch: premiumFetch \}\)/);
  });
});
