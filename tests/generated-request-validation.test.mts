import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { serverOptions } from '../server/gateway.ts';
import { validateGeneratedRequest } from '../server/request-validator.ts';
import { GENERATED_REQUEST_TYPES } from '../src/generated/server/request_validation.ts';
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

  it('enforces UTF-8 byte ceilings and exact contract versions', () => {
    assert.deepEqual(validateGeneratedRequest('createMonitoredCompany', {
      company: {
        name: 'é'.repeat(129),
        domicileCountry: 'DOMICILE_COUNTRY_US',
        aliases: [],
      },
    }), [
      { field: 'company.name', description: 'string UTF-8 length must be at most 256 bytes' },
    ]);

    assert.deepEqual(validateGeneratedRequest('importMonitoredCompanyBatch', {
      contractVersion: 'cm-import-v2',
      clientImportId: 'import-001',
      rows: [{
        ordinal: 0,
        company: {
          name: 'Example Holdings',
          domicileCountry: 'DOMICILE_COUNTRY_GB',
          aliases: [],
        },
      }],
    }), [
      { field: 'contractVersion', description: 'string must equal cm-import-v1' },
    ]);

    assert.deepEqual(validateGeneratedRequest('createMonitoredCompany', {
      company: {
        name: 'Missing Domicile',
        aliases: [],
      },
    }), [
      { field: 'company.domicileCountry', description: 'value is required' },
    ]);
    assert.deepEqual(validateGeneratedRequest('createMonitoredCompany', {
      company: {
        name: 'Unspecified Domicile',
        domicileCountry: 'DOMICILE_COUNTRY_UNSPECIFIED',
        aliases: [],
      },
    }), [
      { field: 'company.domicileCountry', description: 'value is required' },
    ]);
    assert.deepEqual(validateGeneratedRequest('createMonitoredCompany', {
      company: {
        name: 'Unknown Domicile',
        domicileCountry: 'DOMICILE_COUNTRY_CA',
        aliases: [],
      },
    }), [
      { field: 'company.domicileCountry', description: 'enum value must be defined' },
    ]);
    assert.deepEqual(validateGeneratedRequest('createMonitoredCompany', {
      company: {
        name: 'Malformed Claims',
        domicileCountry: 'DOMICILE_COUNTRY_US',
        domains: ['https://example.com/path'],
        xHandles: ['not-a-handle!'],
      },
    }), [
      {
        field: 'company.domains[0]',
        description: 'string must match pattern ^(?:www\\.)?(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.?$',
      },
      {
        field: 'company.xHandles[0]',
        description: 'string must match pattern ^@?[A-Za-z0-9_]{1,15}$',
      },
    ]);
    assert.deepEqual(validateGeneratedRequest('updateMonitoredCompany', {
      companyId: 'cm_company_01JNZB2Y7K4F6W8P9Q0R1S2T3V',
      patch: {
        addClaims: [{ type: 'COMPANY_CLAIM_TYPE_UNSPECIFIED', value: 'x' }],
        removeClaimIds: ['internal-document-id'],
      },
    }), [
      { field: 'patch.addClaims[0].type', description: 'value is required' },
      {
        field: 'patch.removeClaimIds[0]',
        description: 'string must match pattern ^cm_claim_[0-9A-HJKMNP-TV-Z]{26}$',
      },
    ]);
    assert.deepEqual(validateGeneratedRequest('listCompanyEventImpacts', {
      companyIds: ['internal-document-id'],
      directions: ['up'],
      lifecycles: ['deleted'],
    }), [
      {
        field: 'companyIds[0]',
        description: 'string must match pattern ^cm_company_[0-9A-HJKMNP-TV-Z]{26}$',
      },
      {
        field: 'directions[0]',
        description: 'string must match pattern ^(?:positive|negative|mixed|MATERIAL_IMPACT_DIRECTION_(?:POSITIVE|NEGATIVE|MIXED))$',
      },
      {
        field: 'lifecycles[0]',
        description: 'string must match pattern ^(?:admitted|corrected|retracted|MATERIAL_IMPACT_LIFECYCLE_(?:ADMITTED|CORRECTED|RETRACTED))$',
      },
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

describe('enum and string-bound validation branches', () => {
  const company = (overrides: Record<string, unknown> = {}) => ({
    company: { name: 'Example Holdings', domicileCountry: 'DOMICILE_COUNTRY_US', aliases: [], ...overrides },
  });

  it('rejects the numeric proto3-JSON enum form with an actionable message', () => {
    // Deliberately narrower than canonical proto3 JSON: the generated server types are
    // string unions and the published OpenAPI documents only the name form, so accepting
    // an integer here would hand a handler a value it is not typed for. Pinned so the
    // decision cannot be reversed silently.
    assert.deepEqual(
      validateGeneratedRequest('createMonitoredCompany', company({ domicileCountry: 1 })),
      [{
        field: 'company.domicileCountry',
        description: 'value must be an enum name (this API does not accept the numeric proto3-JSON enum form)',
      }],
    );
  });

  it('rejects an undeclared enum name even without enum.defined_only', () => {
    assert.deepEqual(
      validateGeneratedRequest('createMonitoredCompany', company({ domicileCountry: 'DOMICILE_COUNTRY_ZZ' })),
      [{ field: 'company.domicileCountry', description: 'enum value must be defined' }],
    );
  });

  it('enforces enum.not_in on the patch domicile field', () => {
    // The only field exercising the generator's number->name reverse lookup end to end.
    assert.deepEqual(
      validateGeneratedRequest('updateMonitoredCompany', {
        companyId: 'cm_company_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        patch: { domicileCountry: 'DOMICILE_COUNTRY_UNSPECIFIED' },
      }),
      [{
        field: 'patch.domicileCountry',
        description: 'enum value must not be DOMICILE_COUNTRY_UNSPECIFIED',
      }],
    );
  });

  it('rejects a present-but-empty patch name, matching create', () => {
    assert.deepEqual(
      validateGeneratedRequest('updateMonitoredCompany', {
        companyId: 'cm_company_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        patch: { name: '' },
      }),
      [{ field: 'patch.name', description: 'string length must be at least 1' }],
    );
  });

  it('accepts a name at exactly the UTF-8 byte ceiling and rejects one byte over', () => {
    // 128 x 'é' = exactly 256 bytes; the existing test only covered a well-over case.
    // A clean request returns undefined, not an empty array.
    assert.equal(validateGeneratedRequest('createMonitoredCompany', company({ name: 'é'.repeat(128) })), undefined);
    assert.deepEqual(
      validateGeneratedRequest('createMonitoredCompany', company({ name: `${'é'.repeat(128)}a` })),
      [{ field: 'company.name', description: 'string UTF-8 length must be at most 256 bytes' }],
    );
  });

  it('counts astral surrogate pairs as their UTF-8 byte length', () => {
    // 65 x U+1F600 = 260 bytes across 130 UTF-16 code units; the fast path must fall
    // through to the encoder rather than answering from `.length`.
    assert.deepEqual(
      validateGeneratedRequest('createMonitoredCompany', company({ name: '\u{1F600}'.repeat(65) })),
      [{ field: 'company.name', description: 'string UTF-8 length must be at most 256 bytes' }],
    );
    assert.equal(validateGeneratedRequest('createMonitoredCompany', company({ name: '\u{1F600}'.repeat(64) })), undefined);
  });
});
