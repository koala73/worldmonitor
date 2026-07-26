import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  createUnavailableChinaCorridorControlTowerResponse,
} from '../shared/china-corridor-control-towers.ts';
import {
  CHINA_CORRIDOR_BREAKER_CACHE_POLICY,
  fetchChinaCorridorControlTowers,
  parseChinaCorridorResponse,
} from '../src/services/supply-chain/china-corridor-control-towers.ts';
import { CircuitBreaker } from '../src/utils/circuit-breaker.ts';

const GENERATED_AT = '2026-07-25T12:00:00.000Z';
const OPENAPI_PATH = '/api/supply-chain/v1/get-china-corridor-control-towers';

function openApiExample() {
  const spec = JSON.parse(readFileSync(
    new URL('../docs/api/SupplyChainService.openapi.json', import.meta.url),
    'utf8',
  ));
  return spec.paths[OPENAPI_PATH].get.responses['200']
    .content['application/json'].example;
}

describe('China corridor client service', () => {
  it('parses a valid RPC response into the canonical corridor payload', () => {
    const canonical = createUnavailableChinaCorridorControlTowerResponse(GENERATED_AT);
    const parsed = parseChinaCorridorResponse({
      payloadJson: JSON.stringify(canonical),
      generatedAt: GENERATED_AT,
      upstreamUnavailable: true,
    });

    assert.deepEqual(parsed, JSON.parse(JSON.stringify(canonical)));
  });

  it('rejects a malformed nested corridor condition before it reaches rendering', () => {
    const canonical = createUnavailableChinaCorridorControlTowerResponse(GENERATED_AT);
    const malformed = structuredClone(canonical) as unknown as {
      corridors: Array<{ conditions: unknown[] }>;
    };
    malformed.corridors[0]!.conditions = [{}];

    assert.throws(
      () => parseChinaCorridorResponse({
        payloadJson: JSON.stringify(malformed),
        generatedAt: GENERATED_AT,
        upstreamUnavailable: false,
      }),
      /Invalid China corridor control-tower response/,
    );
  });

  it('rejects malformed nested source-signal fields before rendering', () => {
    const mutations: Array<{
      label: string;
      apply: (signal: Record<string, unknown>) => void;
    }> = [
      {
        label: 'publisher type',
        apply: (signal) => {
          (signal.publisher as Record<string, unknown>).type = 'opaque';
        },
      },
      {
        label: 'time precision',
        apply: (signal) => {
          signal.observationTimePrecision = 'second';
        },
      },
      {
        label: 'revision sequence',
        apply: (signal) => {
          signal.revision = {
            vintageId: 'test-vintage',
            sequence: 'first',
            state: 'original',
          };
        },
      },
      {
        label: 'metric value',
        apply: (signal) => {
          signal.metrics = { nested: {} };
        },
      },
    ];

    for (const mutation of mutations) {
      const example = openApiExample();
      const malformed = JSON.parse(example.payloadJson);
      const signal = malformed.corridors[0]!.conditions[0]!
        .sourceSignals[0] as unknown as Record<string, unknown>;
      mutation.apply(signal);

      assert.throws(
        () => parseChinaCorridorResponse({
          payloadJson: JSON.stringify(malformed),
          generatedAt: example.generatedAt,
          upstreamUnavailable: example.upstreamUnavailable,
        }),
        /Invalid China corridor control-tower response/,
        mutation.label,
      );
    }
  });

  it('rejects contradictory condition availability, source, and provenance states', () => {
    const mutations: Array<{
      label: string;
      apply: (condition: Record<string, unknown>) => void;
    }> = [
      {
        label: 'source-less available condition',
        apply: (condition) => {
          condition.sourceSignals = [];
          condition.provenance = null;
        },
      },
      {
        label: 'available condition without provenance',
        apply: (condition) => {
          condition.provenance = null;
        },
      },
      {
        label: 'unavailable condition with a usable signal',
        apply: (condition) => {
          condition.availability = 'unavailable';
          condition.provenance = null;
        },
      },
      {
        label: 'available condition with mixed unavailable signals',
        apply: (condition) => {
          const signals = condition.sourceSignals as Array<Record<string, unknown>>;
          signals.push({
            ...structuredClone(signals[0]),
            id: 'signal:test:unavailable',
            availability: 'unavailable',
            transportFreshness: 'missing',
            contentFreshness: 'unavailable',
          });
        },
      },
      {
        label: 'available condition with missing transport freshness',
        apply: (condition) => {
          const signals = condition.sourceSignals as Array<Record<string, unknown>>;
          signals[0]!.transportFreshness = 'missing';
        },
      },
      {
        label: 'available condition with stale source availability',
        apply: (condition) => {
          const signals = condition.sourceSignals as Array<Record<string, unknown>>;
          signals[0]!.availability = 'stale';
        },
      },
      {
        label: 'available condition with partial content freshness',
        apply: (condition) => {
          const signals = condition.sourceSignals as Array<Record<string, unknown>>;
          signals[0]!.contentFreshness = 'partial';
        },
      },
      {
        label: 'unavailable condition with provenance',
        apply: (condition) => {
          condition.availability = 'unavailable';
          condition.sourceSignals = [];
        },
      },
    ];

    for (const mutation of mutations) {
      const example = openApiExample();
      const malformed = JSON.parse(example.payloadJson);
      const condition = malformed.corridors[0]!
        .conditions[0] as Record<string, unknown>;
      mutation.apply(condition);

      assert.throws(
        () => parseChinaCorridorResponse({
          payloadJson: JSON.stringify(malformed),
          generatedAt: example.generatedAt,
          upstreamUnavailable: example.upstreamUnavailable,
        }),
        /Invalid China corridor control-tower response/,
        mutation.label,
      );
    }
  });

  it('rejects corridor geometry and nodes bound to a different corridor id', () => {
    const example = openApiExample();
    const malformed = JSON.parse(example.payloadJson);
    const first = malformed.corridors[0]!;
    const second = malformed.corridors[1]!;
    first.boundary = structuredClone(second.boundary);
    first.nodes = structuredClone(second.nodes);

    assert.throws(
      () => parseChinaCorridorResponse({
        payloadJson: JSON.stringify(malformed),
        generatedAt: example.generatedAt,
        upstreamUnavailable: example.upstreamUnavailable,
      }),
      /Invalid China corridor control-tower response/,
    );
  });

  it('rejects source selectors and provenance bound to another corridor', () => {
    type MutableCorridorExample = {
      corridors: Array<{
        conditions: Array<{
          sourceSignals: Array<{
            selectorId: string;
            corridorIds?: string[];
          }>;
          provenance: unknown;
        }>;
      }>;
    };
    const mutations: Array<{
      label: string;
      apply: (payload: MutableCorridorExample) => void;
    }> = [
      {
        label: 'selector from another corridor',
        apply: (payload) => {
          payload.corridors[0].conditions[0].sourceSignals[0].selectorId =
            'port1189';
        },
      },
      {
        label: 'explicit corridor id from another corridor',
        apply: (payload) => {
          payload.corridors[0].conditions[0].sourceSignals[0].corridorIds = [
            'china-greater-bay-area',
          ];
        },
      },
      {
        label: 'provenance from another corridor',
        apply: (payload) => {
          payload.corridors[0].conditions[0].provenance =
            structuredClone(payload.corridors[1].conditions[0].provenance);
        },
      },
    ];

    for (const mutation of mutations) {
      const example = openApiExample();
      const malformed = JSON.parse(example.payloadJson) as MutableCorridorExample;
      mutation.apply(malformed);

      assert.throws(
        () => parseChinaCorridorResponse({
          payloadJson: JSON.stringify(malformed),
          generatedAt: example.generatedAt,
          upstreamUnavailable: example.upstreamUnavailable,
        }),
        /Invalid China corridor control-tower response/,
        mutation.label,
      );
    }
  });

  it('rejects RPC metadata that disagrees with the canonical payload', () => {
    const canonical = createUnavailableChinaCorridorControlTowerResponse(GENERATED_AT);
    const response = {
      payloadJson: JSON.stringify(canonical),
      generatedAt: GENERATED_AT,
      upstreamUnavailable: true,
    };

    assert.throws(
      () => parseChinaCorridorResponse({
        ...response,
        generatedAt: '2026-07-25T12:01:00.000Z',
      }),
      /Invalid China corridor control-tower response/,
    );
    assert.throws(
      () => parseChinaCorridorResponse({
        ...response,
        upstreamUnavailable: false,
      }),
      /Invalid China corridor control-tower response/,
    );
  });

  it('keeps the documented OpenAPI example valid at the production parser boundary', () => {
    const parsed = parseChinaCorridorResponse(openApiExample());
    assert.equal(parsed.corridors.length, 4);
    assert.equal(
      parsed.corridors.every((corridor) => corridor.conditions.length === 6),
      true,
    );
  });

  it('returns fail-closed towers when the circuit breaker falls back', async () => {
    const response = await fetchChinaCorridorControlTowers({
      now: () => new Date(GENERATED_AT),
      getResponse: async () => {
        throw new Error('RPC unavailable');
      },
      execute: async (operation, fallback) => {
        try {
          return await operation();
        } catch {
          return fallback;
        }
      },
    });

    assert.equal(response.generatedAt, GENERATED_AT);
    assert.equal(response.corridors.length, 4);
    assert.equal(
      response.corridors.every((corridor) => corridor.availability === 'unavailable'),
      true,
    );
  });

  it('returns fail-closed towers when the breaker boundary itself throws', async () => {
    const response = await fetchChinaCorridorControlTowers({
      now: () => new Date(GENERATED_AT),
      getResponse: async () => {
        throw new Error('must not run');
      },
      execute: async () => {
        throw new Error('breaker unavailable');
      },
    });

    assert.equal(response.generatedAt, GENERATED_AT);
    assert.equal(
      response.corridors.every((corridor) => corridor.availability === 'unavailable'),
      true,
    );
  });

  it('does not pin successful all-unavailable responses in the client breaker cache', async () => {
    const breaker = new CircuitBreaker({
      name: 'China Corridor Control Towers test',
      ...CHINA_CORRIDOR_BREAKER_CACHE_POLICY,
    });
    const serverFailClosed = createUnavailableChinaCorridorControlTowerResponse(
      GENERATED_AT,
      'Server preserved the audited source failure.',
    );
    const genericFallback = createUnavailableChinaCorridorControlTowerResponse(
      GENERATED_AT,
      'Generic client fallback.',
    );

    const response = await breaker.execute(
      async () => serverFailClosed,
      genericFallback,
    );

    assert.equal(
      response.corridors[0]!.conditions[0]!.reason,
      'Server preserved the audited source failure.',
    );
    assert.equal(breaker.getCached(), null);
  });
});
