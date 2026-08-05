import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { transformSync } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const serviceSource = readFileSync(resolve(root, 'src/services/military-flights.ts'), 'utf8');
let moduleCounter = 0;

type PageRequest = {
  pageSize: number;
  cursor: string;
  neLat: number;
  neLon: number;
  swLat: number;
  swLon: number;
};

type PageResponse = {
  flights?: ReturnType<typeof protoFlight>[];
  pagination?: { nextCursor: string; totalCount: number };
};

function replaceRequired(source: string, search: string | RegExp, replacement: string, label: string): string {
  const patched = source.replace(search, replacement);
  assert.notEqual(patched, source, `failed to patch military service import: ${label}`);
  return patched;
}

async function loadMilitaryService(handler: (req: PageRequest) => Promise<PageResponse> | PageResponse) {
  const hookName = `__wmMilitaryPaginationTest${++moduleCounter}`;
  (globalThis as Record<string, unknown>)[hookName] = handler;

  let patched = replaceRequired(
    serviceSource,
    "import type { MilitaryFlight, MilitaryFlightCluster, MilitaryAircraftType, MilitaryOperator } from '@/types';",
    'type MilitaryFlight = any; type MilitaryFlightCluster = any; type MilitaryAircraftType = any; type MilitaryOperator = any;',
    'application types',
  );
  patched = replaceRequired(
    patched,
    "import { createCircuitBreaker, toUniqueSortedLowercase } from '@/utils';",
    `const createCircuitBreaker = (_config: unknown) => ({
      async execute(fn: () => Promise<unknown>, fallback: unknown) {
        try { return await fn(); } catch { return fallback; }
      },
      getStatus() { return 'closed'; },
    });
    const toUniqueSortedLowercase = (values: string[]) => [...new Set(values.map((value) => value.toLowerCase()))].sort();`,
    'utilities',
  );
  patched = replaceRequired(
    patched,
    /import \{\n {2}identifyByCallsign,[\s\S]*?\} from '@\/config\/military';\nimport type \{ QueryRegion \} from '@\/config\/military';/,
    `const identifyByCallsign = () => undefined;
    const identifyByAircraftType = () => undefined;
    const isKnownMilitaryHex = () => undefined;
    const getNearbyHotspot = () => undefined;
    const MILITARY_HOTSPOTS: any[] = [];
    const MILITARY_QUERY_REGIONS = [
      { name: 'alpha', lamin: 0, lamax: 1, lomin: 0, lomax: 1 },
      { name: 'bravo', lamin: 10, lamax: 11, lomin: 10, lomax: 11 },
    ];
    type QueryRegion = any;`,
    'military config',
  );
  patched = replaceRequired(
    patched,
    "import type { MilitaryFlight as ProtoMilitaryFlight, MilitaryAircraftType as ProtoMilitaryAircraftType, MilitaryOperator as ProtoMilitaryOperator } from '@/generated/client/worldmonitor/military/v1/service_client';",
    'type ProtoMilitaryFlight = any; type ProtoMilitaryAircraftType = any; type ProtoMilitaryOperator = any;',
    'generated military types',
  );
  patched = replaceRequired(
    patched,
    "import { getRpcBaseUrl } from '@/services/rpc-client';",
    "const getRpcBaseUrl = () => '';",
    'RPC base URL',
  );
  patched = replaceRequired(
    patched,
    /import \{\n {2}getAircraftDetailsBatch,[\s\S]*?\} from '\.\/wingbits';/,
    `const getAircraftDetailsBatch = async () => new Map();
    const analyzeAircraftDetails = () => ({});
    const checkWingbitsStatus = async () => false;`,
    'Wingbits',
  );
  patched = replaceRequired(
    patched,
    "import { isFeatureAvailable } from './runtime-config';",
    'const isFeatureAvailable = () => true;',
    'runtime config',
  );
  patched = replaceRequired(
    patched,
    "import { isDesktopRuntime, toApiUrl } from './runtime';",
    "const isDesktopRuntime = () => false; const toApiUrl = (path: string) => path;",
    'runtime',
  );
  patched = replaceRequired(
    patched,
    "import { MilitaryServiceClient } from '@/services/generated-rpc-clients';",
    `class MilitaryServiceClient {
      constructor(..._args: unknown[]) {}
      listMilitaryFlights(req: PageRequest) {
        return (globalThis as any)[${JSON.stringify(hookName)}](req);
      }
    }`,
    'military RPC client',
  );
  patched = replaceRequired(
    patched,
    "const wsRelayUrl = import.meta.env.VITE_WS_RELAY_URL || '';",
    "const wsRelayUrl = '';",
    'Vite environment',
  );

  const transformed = transformSync(patched, {
    loader: 'ts',
    format: 'esm',
    target: 'es2022',
  });
  const dataUrl = `data:text/javascript;base64,${Buffer.from(transformed.code).toString('base64')}#${moduleCounter}`;

  try {
    const module = await import(dataUrl) as {
      fetchMilitaryFlights(): Promise<{ flights: Array<{ hexCode: string }>; clusters: unknown[] }>;
    };
    return {
      module,
      cleanup() {
        delete (globalThis as Record<string, unknown>)[hookName];
      },
    };
  } catch (error) {
    delete (globalThis as Record<string, unknown>)[hookName];
    throw error;
  }
}

function protoFlight(hexCode: string, latitude = 20, longitude = 20) {
  return {
    id: hexCode,
    callsign: hexCode,
    hexCode,
    registration: '',
    aircraftType: 'MILITARY_AIRCRAFT_TYPE_UNKNOWN',
    aircraftModel: '',
    operator: 'MILITARY_OPERATOR_OTHER',
    operatorCountry: '',
    location: { latitude, longitude },
    altitude: 20_000,
    heading: 90,
    speed: 300,
    verticalRate: 0,
    onGround: false,
    squawk: '',
    origin: '',
    destination: '',
    lastSeenAt: 1_700_000_000_000,
    firstSeenAt: 0,
    confidence: 'MILITARY_CONFIDENCE_LOW',
    isInteresting: false,
    note: '',
  };
}

function regionName(req: PageRequest): 'alpha' | 'bravo' {
  return req.swLat === 0 ? 'alpha' : 'bravo';
}

describe('military flight application-service pagination', { concurrency: 1 }, () => {
  it('follows every region page, combines rows, and preserves cross-region hex deduplication', async () => {
    const cursorsByRegion = new Map<string, string[]>();
    const { module, cleanup } = await loadMilitaryService((req) => {
      const region = regionName(req);
      cursorsByRegion.set(region, [...(cursorsByRegion.get(region) ?? []), req.cursor]);

      if (region === 'alpha' && req.cursor === '') {
        return {
          flights: [protoFlight('AAA001'), protoFlight('DUP001')],
          pagination: { nextCursor: 'alpha-2', totalCount: 3 },
        };
      }
      if (region === 'alpha' && req.cursor === 'alpha-2') {
        return {
          flights: [protoFlight('AAA002')],
          pagination: { nextCursor: '', totalCount: 3 },
        };
      }
      if (region === 'bravo' && req.cursor === '') {
        return {
          flights: [protoFlight('DUP001'), protoFlight('BBB001')],
          pagination: { nextCursor: 'bravo-2', totalCount: 3 },
        };
      }
      if (region === 'bravo' && req.cursor === 'bravo-2') {
        return {
          flights: [protoFlight('BBB002')],
          pagination: { nextCursor: '', totalCount: 3 },
        };
      }
      throw new Error(`unexpected ${region} cursor ${JSON.stringify(req.cursor)}`);
    });

    try {
      const result = await module.fetchMilitaryFlights();

      assert.deepEqual(cursorsByRegion.get('alpha'), ['', 'alpha-2']);
      assert.deepEqual(cursorsByRegion.get('bravo'), ['', 'bravo-2']);
      assert.deepEqual(
        result.flights.map((flight) => flight.hexCode),
        ['AAA001', 'DUP001', 'AAA002', 'BBB001', 'BBB002'],
      );
      assert.equal(
        result.flights.filter((flight) => flight.hexCode === 'DUP001').length,
        1,
        'a flight present in two query regions must still appear once',
      );
    } finally {
      cleanup();
    }
  });

  it('stops after the first response from an old server without pagination metadata', async () => {
    const calls: PageRequest[] = [];
    const { module, cleanup } = await loadMilitaryService((req) => {
      calls.push(req);
      return {
        flights: [protoFlight(regionName(req) === 'alpha' ? 'OLD001' : 'OLD002')],
      };
    });

    try {
      const result = await module.fetchMilitaryFlights();

      assert.equal(calls.length, 2, 'one request per query region is sufficient for an old server');
      assert.ok(calls.every((req) => req.cursor === ''));
      assert.deepEqual(result.flights.map((flight) => flight.hexCode), ['OLD001', 'OLD002']);
    } finally {
      cleanup();
    }
  });

  it('fails closed to the breaker snapshot when a region cursor never terminates', async () => {
    const cursorsByRegion = new Map<string, string[]>();
    const { module, cleanup } = await loadMilitaryService((req) => {
      const region = regionName(req);
      cursorsByRegion.set(region, [...(cursorsByRegion.get(region) ?? []), req.cursor]);

      if (region === 'bravo') {
        return { flights: [protoFlight('HEALTHY001')] };
      }
      if (req.cursor === '') {
        return {
          flights: [protoFlight('REPEATED001')],
          pagination: { nextCursor: 'repeat-me', totalCount: 2 },
        };
      }
      return {
        flights: [protoFlight('REPEATED002')],
        pagination: { nextCursor: 'repeat-me', totalCount: 2 },
      };
    });

    try {
      // A non-terminating region must abort the whole fetch so the circuit
      // breaker keeps its last COMPLETE snapshot, rather than caching a
      // truncated global picture. The stub breaker surfaces that as the empty
      // fallback; the real breaker replays its prior full result.
      const result = await module.fetchMilitaryFlights();

      assert.deepEqual(cursorsByRegion.get('alpha'), ['', 'repeat-me'], 'the region stops after detecting the repeat');
      assert.deepEqual(result.flights, [], 'a non-terminating region must not cache a partial dataset');
    } finally {
      cleanup();
    }
  });

  it('fails closed instead of caching a region truncated by a later-page error', async () => {
    const alphaCursors: string[] = [];
    const { module, cleanup } = await loadMilitaryService((req) => {
      const region = regionName(req);
      if (region === 'bravo') {
        return { flights: [protoFlight('HEALTHY001')] };
      }
      alphaCursors.push(req.cursor);
      if (req.cursor === '') {
        return {
          flights: [protoFlight('PAGE1')],
          pagination: { nextCursor: 'alpha-2', totalCount: 2 },
        };
      }
      throw new Error('simulated later-page transport failure');
    });

    try {
      const result = await module.fetchMilitaryFlights();

      assert.deepEqual(alphaCursors, ['', 'alpha-2'], 'the loader attempts the second page before failing');
      assert.deepEqual(
        result.flights,
        [],
        'a mid-chain failure must fail the whole fetch, not silently drop page 1 and cache a partial region',
      );
    } finally {
      cleanup();
    }
  });

  it('fails closed when a continuation page comes back empty (snapshot shrank mid-loop)', async () => {
    const alphaCursors: string[] = [];
    const { module, cleanup } = await loadMilitaryService((req) => {
      const region = regionName(req);
      if (region === 'bravo') {
        return { flights: [protoFlight('HEALTHY001')] };
      }
      alphaCursors.push(req.cursor);
      if (req.cursor === '') {
        return {
          flights: [protoFlight('PAGE1')],
          pagination: { nextCursor: 'alpha-2', totalCount: 2 },
        };
      }
      // Continuation returns a healthy 200 but with no rows — the server's
      // cached snapshot expired and its live+stale refetch produced nothing.
      return { flights: [], pagination: { nextCursor: '', totalCount: 0 } };
    });

    try {
      const result = await module.fetchMilitaryFlights();

      assert.deepEqual(alphaCursors, ['', 'alpha-2'], 'the loader requests the advertised second page');
      assert.deepEqual(
        result.flights,
        [],
        'an empty continuation page must fail the fetch, not silently cache page 1 as complete',
      );
    } finally {
      cleanup();
    }
  });

  it('tolerates a region that is unavailable on its first page', async () => {
    const { module, cleanup } = await loadMilitaryService((req) => {
      if (regionName(req) === 'alpha') {
        throw new Error('region alpha upstream is down');
      }
      return { flights: [protoFlight('BRAVO001')] };
    });

    try {
      const result = await module.fetchMilitaryFlights();

      assert.deepEqual(
        result.flights.map((flight) => flight.hexCode),
        ['BRAVO001'],
        'a region down on its first call degrades to empty while healthy regions still render',
      );
    } finally {
      cleanup();
    }
  });

  it('bounds a region whose server never stops emitting a fresh cursor', async () => {
    let alphaCalls = 0;
    const { module, cleanup } = await loadMilitaryService((req) => {
      if (regionName(req) === 'bravo') {
        return { flights: [protoFlight('HEALTHY001')] };
      }
      alphaCalls += 1;
      return {
        flights: [protoFlight(`FRESH${alphaCalls}`)],
        pagination: { nextCursor: `page-${alphaCalls}`, totalCount: 9999 },
      };
    });

    try {
      const result = await module.fetchMilitaryFlights();

      assert.equal(alphaCalls, 50, 'traversal is capped at the region page ceiling instead of looping forever');
      assert.deepEqual(result.flights, [], 'an unbounded region fails closed rather than caching partial data');
    } finally {
      cleanup();
    }
  });
});
