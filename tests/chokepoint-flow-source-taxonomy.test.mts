/**
 * FlowEstimate.source closed-taxonomy gate (#6101).
 *
 * `source` was a bare `string` documented only in prose, so nothing could
 * discover its legal values and nothing caught a typo or a silently-added
 * third one. It is now the `FlowSource` proto enum, whose custom JSON names
 * keep the hyphenated wire values verbatim.
 *
 * Declaring a closed taxonomy is only worth doing if the response cannot carry
 * a value outside it, and `energy:chokepoint-flows:v1` is written by a seeder
 * that deploys independently of this handler — so the pass-through and the
 * collapse are both driven through the REAL handler here, not asserted off its
 * source text.
 *
 * Every case rides ONE handler invocation on a different chokepoint id:
 * `getChokepointStatus` memoizes its whole response under a single cache key,
 * so a second call would answer from cache and quietly assert against the first
 * scenario's data.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// The sidecar cache is the handler's in-memory Redis seam. Set before importing
// anything that reads it so the module graph never sees the real credentials.
process.env.LOCAL_API_MODE = 'tauri-sidecar';
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const { sidecarCacheSet } = await import('../server/_shared/sidecar-cache.ts');
const { getChokepointStatus } = await import(
  '../server/worldmonitor/supply-chain/v1/get-chokepoint-status.ts'
);
// Safe to import: seed-chokepoint-flows.mjs guards its runSeed call behind
// `isMain`, so nothing executes and no Redis credentials are read on import.
const { resolveFlowSource } = await import('../scripts/seed-chokepoint-flows.mjs');

const proto = readFileSync(
  resolve(root, 'proto/worldmonitor/supply_chain/v1/supply_chain_data.proto'),
  'utf-8',
);
const generatedTs = readFileSync(
  resolve(root, 'src/generated/server/worldmonitor/supply_chain/v1/service_server.ts'),
  'utf-8',
);
const generatedTsClient = readFileSync(
  resolve(root, 'src/generated/client/worldmonitor/supply_chain/v1/service_client.ts'),
  'utf-8',
);
const openapi = JSON.parse(
  readFileSync(resolve(root, 'docs/api/SupplyChainService.openapi.json'), 'utf-8'),
) as {
  components: {
    schemas: Record<string, { properties: Record<string, { type?: string; enum?: string[] }> }>;
  };
};

const flowEstimateSchema = openapi.components.schemas.FlowEstimate!.properties;

/** The two coverage bases the seeder can actually emit. */
const SEEDER_SOURCES = ['portwatch-dwt', 'portwatch-counts'] as const;
/** The declared way to say "not one of the known coverage bases". */
const UNSPECIFIED = 'FLOW_SOURCE_UNSPECIFIED';

// ── the taxonomy is discoverable from the schema ──────────────────────────────

describe('FlowEstimate.source is a closed taxonomy (#6101)', () => {
  it('declares FlowSource in the proto with the wire values preserved', () => {
    assert.match(proto, /FlowSource source = 5;/);
    for (const value of SEEDER_SOURCES) {
      assert.match(
        proto,
        new RegExp(`\\(sebuf\\.http\\.enum_value\\) = "${value}"`),
        `FlowSource must map a symbol onto the "${value}" wire value`,
      );
    }
  });

  it('generates a TypeScript literal union carrying both wire values', () => {
    // Both halves: the server types the handler compiles against, and the
    // client types an SDK consumer imports. Asserting only the server would let
    // a half-run `make generate` ship a client that still says `string`.
    for (const [label, src] of [['server', generatedTs], ['client', generatedTsClient]] as const) {
      const union = src.match(/export type FlowSource = ([^;]+);/)?.[1];
      assert.ok(union, `generated ${label} types must export a FlowSource union`);
      for (const value of SEEDER_SOURCES) {
        assert.ok(union.includes(`"${value}"`), `${label} FlowSource union must contain "${value}"`);
      }
      assert.match(src, /\n\s*source: FlowSource;/, `${label} FlowEstimate.source must be typed by it`);
    }
  });

  it('generates an OpenAPI enum list rather than a bare string', () => {
    assert.deepEqual(flowEstimateSchema.source!.enum, [UNSPECIFIED, ...SEEDER_SOURCES]);
    assert.equal(flowEstimateSchema.source!.type, 'string');
  });

  it('pins the seeder to exactly the declared wire values, by running its decision', () => {
    // EXECUTE the seeder's own selector rather than grepping for its literals.
    // A text scrape extracts the same two strings whether the mapping is right
    // or inverted, so it could not distinguish `useDwt -> dwt` from
    // `useDwt -> counts`; and a scrape bound to the `a ? 'x' : 'y'` shape misses
    // a third basis added at a second assignment site entirely.
    assert.equal(resolveFlowSource(true), 'portwatch-dwt', 'DWT-majority coverage must report the DWT basis');
    assert.equal(resolveFlowSource(false), 'portwatch-counts', 'vessel-count coverage must report the count basis');

    // The full range of the selector must be inside the declared taxonomy.
    const emitted = new Set([resolveFlowSource(true), resolveFlowSource(false)]);
    assert.deepEqual(
      [...emitted].sort(),
      [...SEEDER_SOURCES].sort(),
      'seeder emits a value the FlowSource taxonomy does not declare',
    );

    // Backstop for the one thing execution cannot see: a value assigned to
    // `source` somewhere other than through the selector. `\bsource:` does not
    // match the sibling `sourceVersion:` key.
    const seeder = readFileSync(resolve(root, 'scripts/seed-chokepoint-flows.mjs'), 'utf-8');
    const literalAssignments = [...seeder.matchAll(/\bsource:([^\n]*)/g)]
      .flatMap(m => [...m[1]!.matchAll(/'([^']+)'/g)].map(q => q[1]!));
    assert.deepEqual(
      literalAssignments, [],
      'a source value is assigned as a literal outside resolveFlowSource, where the executed check cannot see it',
    );
  });
});

// ── the served bytes match the declaration ────────────────────────────────────

interface ServedFlowEstimate {
  source: string;
  hazardAlertLevel: string;
}

const originalFetch = globalThis.fetch;

describe('the chokepoint handler serves only declared FlowSource values (#6101)', () => {
  let served: Map<string, ServedFlowEstimate>;

  after(() => {
    globalThis.fetch = originalFetch;
  });

  before(async () => {
    // The handler fans out to listNavigationalWarnings (msi.nga.mil) and
    // getVesselSnapshot (the relay) before it ever builds a flowEstimate. Left
    // unstubbed this gate reaches the live internet on every CI run — a flake
    // and a latency tax for assertions that are entirely about cached Redis
    // content. Both callers already catch and degrade, so a rejected fetch is
    // the fast, deterministic path. Mirrors tests/empty-200-degradation-handlers.test.mts.
    globalThis.fetch = (async () => {
      throw new Error('network disabled in chokepoint-flow-source-taxonomy test');
    }) as typeof globalThis.fetch;

    sidecarCacheSet('supply_chain:transit-summaries:v1', {
      summaries: {
        suez: {
          todayTotal: 10, todayTanker: 5, todayCargo: 3, todayOther: 2, wowChangePct: 0,
          history: [], riskLevel: 'low', incidentCount7d: 0, disruptionPct: 0,
          riskSummary: '', riskReportAction: '', dataAvailable: true,
        },
      },
    }, 300);

    const flow = (source: unknown, hazard: string | null = null) => ({
      currentMbd: 1, baselineMbd: 2, flowRatio: 0.5, disrupted: false,
      ...(source === undefined ? {} : { source }),
      hazardAlertLevel: hazard, hazardAlertName: hazard ? 'Cyclone Fixture' : null,
    });

    // One invocation, one scenario per chokepoint id.
    sidecarCacheSet('energy:chokepoint-flows:v1', {
      suez: flow('portwatch-dwt'),
      hormuz_strait: flow('portwatch-counts'),
      malacca_strait: flow('portwatch-lidar'), // a value shipped after this deploy
      panama: flow(''),
      korea_strait: flow(undefined), // key absent entirely
      dover_strait: flow(42), // seeder bug: not even a string
      bab_el_mandeb: flow('portwatch-dwt', 'RED'), // a real GDACS alert, not the null coalesce
    }, 300);

    const response = await getChokepointStatus({} as never, {} as never);
    // Assert on the SERIALIZED response, not the in-process object: the wire is
    // JSON, and absent-vs-null-vs-"" only diverge across that boundary. Same
    // discipline docs/solutions/design-patterns/contract-gate-field-names-miss-value-axis.md
    // prescribes for this message family.
    const wire = JSON.parse(JSON.stringify(response)) as typeof response;
    served = new Map(
      wire.chokepoints
        .filter(cp => cp.flowEstimate)
        .map(cp => [cp.id, cp.flowEstimate as unknown as ServedFlowEstimate]),
    );
    assert.equal(served.size, 7, 'fixture must reach the handler for all seven chokepoints');
  });

  it('passes the seeder\'s real values through verbatim — no wire change', () => {
    assert.equal(served.get('suez')!.source, 'portwatch-dwt');
    assert.equal(served.get('hormuz_strait')!.source, 'portwatch-counts');
  });

  it('collapses a value outside the taxonomy to FLOW_SOURCE_UNSPECIFIED', () => {
    assert.equal(served.get('malacca_strait')!.source, UNSPECIFIED);
  });

  it('collapses empty, absent, and non-string sources to FLOW_SOURCE_UNSPECIFIED', () => {
    assert.equal(served.get('panama')!.source, UNSPECIFIED);
    assert.equal(served.get('korea_strait')!.source, UNSPECIFIED);
    assert.equal(served.get('dover_strait')!.source, UNSPECIFIED);
  });

  it('serves nothing the published OpenAPI enum does not list', () => {
    const declared = new Set(flowEstimateSchema.source!.enum);
    for (const [id, estimate] of served) {
      assert.ok(
        declared.has(estimate.source),
        `${id} served source "${estimate.source}", which is not in the published enum`,
      );
    }
  });

  it('keeps serving the empty string for hazardAlertLevel, and declares it honestly', () => {
    // The counterpart half of #6101 stayed a bare `string`: sebuf v0.11.1 drops
    // an EMPTY (sebuf.http.enum_value) and falls back to the proto symbol, so
    // "" cannot be an enum JSON name (#6106). This is the invariant that
    // decision has to keep — a future promotion is fine only if "" survives it.
    assert.equal(served.get('suez')!.hazardAlertLevel, '', 'no-alert is still the empty string');
    // Positive control for the line above: a real GDACS level must survive
    // untouched, so "" is the no-alert encoding rather than the only thing this
    // field can ever be.
    assert.equal(served.get('bab_el_mandeb')!.hazardAlertLevel, 'RED');
    const hazard = flowEstimateSchema.hazardAlertLevel!;
    if (hazard.enum) {
      assert.ok(
        hazard.enum.includes(''),
        'hazardAlertLevel was promoted to an enum that omits the empty string the handler serves',
      );
    } else {
      assert.equal(hazard.type, 'string');
    }
  });
});

// ── the guarantee survives the outer response cache ───────────────────────────

describe('the chokepoint handler re-narrows a cached response (#6101)', () => {
  // `getChokepointStatus` memoizes its whole response under
  // supply_chain:chokepoints:v4. Narrowing only inside the cold-path builder
  // would leave that key holding a pre-deploy blob for the rest of its TTL --
  // served verbatim, and read straight from that key by route-intelligence,
  // get-bypass-options, both cost-shock handlers, get-route-explorer-lane and
  // the bootstrap tier. This drives the WARM path specifically.
  it('narrows an undeclared source that was already in the response cache', async () => {
    sidecarCacheSet('supply_chain:chokepoints:v4', {
      chokepoints: [{
        id: 'suez',
        name: 'Suez Canal',
        flowEstimate: {
          currentMbd: 1, baselineMbd: 2, flowRatio: 0.5, disrupted: false,
          source: 'portwatch-lidar', // written by a build that predates this taxonomy
          hazardAlertLevel: '', hazardAlertName: '',
        },
      }],
      fetchedAt: new Date().toISOString(),
      upstreamUnavailable: false,
    }, 300);

    const response = await getChokepointStatus({} as never, {} as never);
    const wire = JSON.parse(JSON.stringify(response)) as typeof response;
    const suez = wire.chokepoints.find(cp => cp.id === 'suez');

    assert.ok(suez?.flowEstimate, 'the cached response must be the one served');
    assert.equal(
      (suez.flowEstimate as unknown as ServedFlowEstimate).source,
      UNSPECIFIED,
      'a cache-warm response still served an undeclared source',
    );
  });
});
