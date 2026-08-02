import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { serverOptions } from '../server/gateway.ts';
import { validateGeneratedRequest } from '../server/request-validator.ts';
import {
  GENERATED_REQUEST_TYPES,
} from '../src/generated/server/request_validation.ts';
import {
  createMarketServiceRoutes,
  type MarketServiceHandler,
} from '../src/generated/server/worldmonitor/market/v1/service_server.ts';
import {
  createBatchServiceRoutes,
  type BatchServiceHandler,
} from '../src/generated/server/worldmonitor/batch/v1/service_server.ts';

const ROOT = join(import.meta.dirname, '..');
const GENERATED_SERVER_ROOT = join(ROOT, 'src/generated/server/worldmonitor');

function walkFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(path) : [path];
  });
}

function generatedMethodNames(): string[] {
  return walkFiles(GENERATED_SERVER_ROOT)
    .filter((path) => path.endsWith('service_server.ts'))
    .flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return [...source.matchAll(/validateRequest\("([^"]+)"/g)].map((match) => match[1]);
    });
}

describe('generated request validation', () => {
  it('registers the production validator and keeps valid requests on the handler path', async () => {
    let handlerCalls = 0;
    const handler = {
      analyzeStock: async () => {
        handlerCalls += 1;
        return { available: true };
      },
    } as unknown as MarketServiceHandler;
    const route = createMarketServiceRoutes(handler, serverOptions)
      .find(({ path }) => path === '/api/market/v1/analyze-stock');

    assert.ok(route);
    const response = await route.handler(new Request(
      'https://worldmonitor.app/api/market/v1/analyze-stock?symbol=AAPL&name=Apple',
    ));

    assert.equal(response.status, 200);
    assert.equal(handlerCalls, 1);
    assert.equal(serverOptions.validateRequest, validateGeneratedRequest);
  });

  it('rejects missing and oversized query fields before the handler runs', async () => {
    let handlerCalls = 0;
    const handler = {
      analyzeStock: async () => {
        handlerCalls += 1;
        return { available: true };
      },
    } as unknown as MarketServiceHandler;
    const route = createMarketServiceRoutes(handler, serverOptions)
      .find(({ path }) => path === '/api/market/v1/analyze-stock');

    assert.ok(route);
    const missing = await route.handler(new Request(
      'https://worldmonitor.app/api/market/v1/analyze-stock',
    ));
    assert.equal(missing.status, 400);
    assert.deepEqual(await missing.json(), {
      violations: [
        { field: 'symbol', description: 'value is required' },
      ],
    });

    const oversized = await route.handler(new Request(
      `https://worldmonitor.app/api/market/v1/analyze-stock?symbol=AAPL&name=${'x'.repeat(121)}`,
    ));
    assert.equal(oversized.status, 400);
    assert.deepEqual(await oversized.json(), {
      violations: [
        { field: 'name', description: 'string length must be at most 120' },
      ],
    });
    assert.equal(handlerCalls, 0);
  });

  it('validates repeated nested request messages', async () => {
    let handlerCalls = 0;
    const handler = {
      executeBatch: async () => {
        handlerCalls += 1;
        return { results: [], succeeded: 0, failed: 0 };
      },
    } as BatchServiceHandler;
    const route = createBatchServiceRoutes(handler, serverOptions)
      .find(({ path }) => path === '/api/batch/v1/execute');

    assert.ok(route);
    const response = await route.handler(new Request(
      'https://worldmonitor.app/api/batch/v1/execute',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operations: [{ id: 'a', path: '' }] }),
      },
    ));

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      violations: [
        { field: 'operations[0].path', description: 'value is required' },
      ],
    });
    assert.equal(handlerCalls, 0);
  });

  it('uses undefined for valid requests and fails closed for unknown generated methods', () => {
    assert.equal(validateGeneratedRequest('analyzeStock', {
      symbol: 'AAPL',
      name: 'Apple',
      includeNews: true,
    }), undefined);
    assert.throws(
      () => validateGeneratedRequest('methodMissingFromGeneratedRegistry', {}),
      /No generated request-validation schema/,
    );
  });

  it('preserves optional zero-value defaults but still rejects invalid explicit values', () => {
    assert.equal(validateGeneratedRequest('getAirportOpsSummary', {
      airports: [],
    }), undefined);
    assert.equal(validateGeneratedRequest('listAirportFlights', {
      airport: 'DXB',
      direction: 'FLIGHT_DIRECTION_BOTH',
      limit: 0,
    }), undefined);
    assert.deepEqual(validateGeneratedRequest('listAirportFlights', {
      airport: 'DXB',
      direction: 'FLIGHT_DIRECTION_BOTH',
      limit: 101,
    }), [
      { field: 'limit', description: 'number must be less than or equal to 100' },
    ]);
    assert.deepEqual(validateGeneratedRequest('listAirportFlights', {
      airport: 'DXB',
      direction: 'FLIGHT_DIRECTION_BOTH',
      limit: Number.NaN,
    }), [
      { field: 'limit', description: 'value must be a finite number' },
    ]);
  });

  it('keeps semantically required batches non-empty', () => {
    assert.deepEqual(validateGeneratedRequest('getFredSeriesBatch', {
      seriesIds: [],
      limit: 0,
    }), [
      { field: 'seriesIds', description: 'array must contain at least 1 item(s)' },
    ]);
    assert.deepEqual(validateGeneratedRequest('executeBatch', {
      operations: [],
    }), [
      { field: 'operations', description: 'array must contain at least 1 item(s)' },
    ]);
  });

  it('accepts the macro-stress FRED batch within the handler limit', () => {
    assert.equal(validateGeneratedRequest('getFredSeriesBatch', {
      seriesIds: Array.from({ length: 11 }, (_, index) => `SERIES_${index}`),
      limit: 120,
    }), undefined);
    assert.deepEqual(validateGeneratedRequest('getFredSeriesBatch', {
      seriesIds: Array.from({ length: 21 }, (_, index) => `SERIES_${index}`),
      limit: 120,
    }), [
      { field: 'seriesIds', description: 'array must contain at most 20 item(s)' },
    ]);
  });

  it('enforces every supported scalar and cardinality rule family', () => {
    assert.deepEqual(validateGeneratedRequest('getFlightStatus', {
      flightNumber: 'AB',
      date: '2026-08-01',
    }), [
      { field: 'flightNumber', description: 'string length must be at least 3' },
    ]);
    assert.deepEqual(validateGeneratedRequest('getFlightStatus', {
      flightNumber: 'EK202',
      date: '20260801',
    }), [
      { field: 'date', description: 'string length must be exactly 10' },
    ]);
    assert.deepEqual(validateGeneratedRequest('getCountryRisk', {
      countryCode: 'us',
    }), [
      { field: 'countryCode', description: 'string must match pattern ^[A-Z]{2}$' },
    ]);
    assert.deepEqual(validateGeneratedRequest('listAirportFlights', {
      airport: 'DXB',
      limit: -1,
    }), [
      { field: 'limit', description: 'number must be greater than or equal to 1' },
    ]);
    assert.deepEqual(validateGeneratedRequest('getIntelTimeline', {
      from: -1,
    }), [
      { field: 'from', description: 'number must be greater than or equal to 0' },
    ]);
    assert.deepEqual(validateGeneratedRequest('getPopulationExposure', {
      lat: 90.1,
      lon: 0,
      radius: 1,
    }), [
      { field: 'lat', description: 'number must be less than or equal to 90' },
    ]);
    assert.deepEqual(validateGeneratedRequest('getAirportOpsSummary', {
      airports: Array.from({ length: 21 }, (_, index) => `A${index}`),
    }), [
      { field: 'airports', description: 'array must contain at most 20 item(s)' },
    ]);
  });

  it('distinguishes an absent proto3 optional scalar from an invalid value', () => {
    assert.equal(validateGeneratedRequest('registerWebhook', {
      callbackUrl: 'https://example.com/webhook',
    }), undefined);
    assert.deepEqual(validateGeneratedRequest('registerWebhook', {
      callbackUrl: 'https://example.com/webhook',
      alertThreshold: -1,
    }), [
      { field: 'alertThreshold', description: 'number must be greater than or equal to 0' },
    ]);
  });

  it('covers every generated callback exactly once and wires Vite to the same validator', () => {
    const callbacks = generatedMethodNames();
    const uniqueCallbacks = new Set(callbacks);
    assert.equal(uniqueCallbacks.size, callbacks.length, 'generated method names must not collide');
    assert.deepEqual(
      [...uniqueCallbacks].sort(),
      Object.keys(GENERATED_REQUEST_TYPES).sort(),
      'the generated validator registry must cover every generated route callback',
    );

    const viteConfig = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
    assert.match(viteConfig, /validateRequest:\s*validateGeneratedRequest/);
  });
});
