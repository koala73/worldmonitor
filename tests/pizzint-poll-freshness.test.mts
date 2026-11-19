import { afterEach, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type PluginBuild } from 'esbuild';

import { REFRESH_INTERVALS } from '../src/config/variants/base.ts';

// The indicator polls on REFRESH_INTERVALS.pizzint with the poll loop's
// default ±10% jitter, so two polls can land 0.9 intervals apart. The relay
// publishes a new BestTime reading every 15 min; one published between polls
// must appear on the next poll.
const SHORTEST_JITTERED_POLL_MS = REFRESH_INTERVALS.pizzint * 0.9;
// The relay's poll interval (PIZZINT_SEED_INTERVAL_MS in scripts/ais-relay.cjs).
const RELAY_POLL_MS = 15 * 60 * 1000;

type Status = { locationsOpen: number };
type Harness = {
  fetchPizzIntStatus: () => Promise<Status>;
  fetchGdeltTensions: () => Promise<Array<{ id: string; evidence?: unknown[] }>>;
  setHydrated: (value: unknown) => void;
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let harness: Harness;

const stubBrowserSeams = {
  name: 'stub-browser-seams',
  setup(b: PluginBuild) {
    b.onResolve({ filter: /services\/bootstrap$/ }, () => ({ path: 'stub:bootstrap', namespace: 'stub-seam' }));
    b.onResolve({ filter: /services\/i18n$/ }, () => ({ path: 'stub:i18n', namespace: 'stub-seam' }));
    b.onResolve({ filter: /services\/rpc-client$/ }, () => ({ path: 'stub:rpc-client', namespace: 'stub-seam' }));
    b.onLoad({ filter: /.*/, namespace: 'stub-seam' }, (args) => ({
      contents: args.path === 'stub:bootstrap'
        // Consume-once, like the real hydration cache.
        ? 'let hydrated; export function setHydrated(v) { hydrated = v; } export function getHydratedData() { const v = hydrated; hydrated = undefined; return v; }'
        : args.path === 'stub:rpc-client'
          ? "export function createLazyClient(make) { let c; return () => (c ??= make()); } export function getRpcBaseUrl() { return 'https://rpc.test'; }"
          : "export function t(key) { return key; } export function getCurrentLanguageTag() { return 'en'; }",
      loader: 'js',
    }));
  },
};

before(async () => {
  const result = await build({
    stdin: {
      contents: "export { fetchPizzIntStatus, fetchGdeltTensions } from './src/services/pizzint.ts'; export { setHydrated } from './src/services/bootstrap';",
      loader: 'ts',
      resolveDir: root,
      sourcefile: 'pizzint-poll-freshness-entry.ts',
    },
    bundle: true,
    alias: { '@': resolve(root, 'src') },
    define: { 'import.meta.env': '{"DEV":false}' },
    format: 'esm',
    logLevel: 'silent',
    platform: 'node',
    target: 'node20',
    write: false,
    plugins: [stubBrowserSeams],
  });
  const source = result.outputFiles[0]?.text;
  assert.ok(source, 'esbuild must emit the pizzint harness');
  harness = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`) as Harness;
});

function response(locationsOpen: number) {
  return {
    pizzint: {
      defconLevel: 5,
      defconLabel: 'Normal Activity',
      aggregateActivity: 0,
      activeSpikes: 0,
      locationsMonitored: 6,
      locationsOpen,
      updatedAt: 0,
      dataFreshness: 'DATA_FRESHNESS_FRESH',
      locations: [],
    },
    tensionPairs: [],
  };
}

afterEach(() => mock.restoreAll());

describe('PizzINT indicator polling freshness', () => {
  it('shows a relay reading published after page load on the next poll, even when jitter shortens the gap', async () => {
    let served = response(5);
    const fetchMock = mock.method(globalThis, 'fetch', async () => Response.json(served));
    let now = Date.parse('2026-10-24T15:00:00Z');
    mock.method(Date, 'now', () => now);

    // Page load renders the bootstrap snapshot (taken before the venues opened).
    harness.setHydrated(response(2));
    assert.equal((await harness.fetchPizzIntStatus()).locationsOpen, 2);

    now += SHORTEST_JITTERED_POLL_MS;
    assert.equal((await harness.fetchPizzIntStatus()).locationsOpen, 5, 'the next poll shows the new reading');
    assert.equal(fetchMock.mock.callCount(), 1);

    served = response(6);
    now += SHORTEST_JITTERED_POLL_MS;
    assert.equal((await harness.fetchPizzIntStatus()).locationsOpen, 6, 'every later poll does too');
  });
});

describe('get-pizzint-status shared cache', () => {
  // Every shared layer (browser, Cloudflare, Vercel CDN) may serve a body for
  // s-maxage/max-age plus stale-while-revalidate. Together they must stay well
  // inside one relay poll, or the CDN becomes the freshness floor.
  it('keeps every cache layer well inside one relay poll', () => {
    const gateway = readFileSync(resolve(root, 'server', 'gateway.ts'), 'utf-8');
    const tier = gateway.match(/'\/api\/intelligence\/v1\/get-pizzint-status':\s*'([^']+)'/)?.[1];
    assert.ok(tier, 'get-pizzint-status must have a cache tier');
    const headerFor = (table: string): string => {
      const block = gateway.match(new RegExp(`const ${table}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`))?.[1] ?? '';
      const line = block.match(new RegExp(`(?:^|\\n)\\s*'?${tier}'?:\\s*('[^']*'|null)`))?.[1];
      assert.ok(line, `${table} must define tier ${tier}`);
      return line === 'null' ? '' : line;
    };
    const seconds = (header: string, directive: string): number =>
      Number(header.match(new RegExp(`${directive}=(\\d+)`))?.[1] ?? 0);
    const browser = headerFor('TIER_HEADERS');
    const cdn = headerFor('TIER_CDN_CACHE');
    const worstCaseMs = 1000 * (
      seconds(cdn, 's-maxage') + seconds(cdn, 'stale-while-revalidate')
      + seconds(browser, 's-maxage') + seconds(browser, 'stale-while-revalidate')
      + seconds(browser, 'max-age')
    );
    assert.ok(worstCaseMs <= RELAY_POLL_MS / 3,
      `tier ${tier} can serve a ${worstCaseMs / 60000}-minute-old body; keep it under ${RELAY_POLL_MS / 3 / 60000} minutes`);
  });
});

describe('tension evidence mapping', () => {
  it('keeps each reading, with no usual level as null, and reads an older response as no evidence', async () => {
    const row = { id: 'usa_iran', countries: ['US', 'IR'], label: 'US–Iran', score: 60,
      trend: 'TREND_DIRECTION_RISING', changePercent: 12, region: 'middle_east' };
    mock.method(globalThis, 'fetch', async () => Response.json({ tensionPairs: [
      { ...row, evidence: [
        { channel: 'military_aircraft', value: 9, baseline: 2.21, countries: ['US'], airports: [], observedAt: 1 },
        { channel: 'airports', value: 1, countries: [], airports: [{ name: 'Tehran Imam Khomeini', status: 'closed' }], observedAt: 2 },
      ] },
      { ...row, id: 'usa_china', countries: ['US', 'CN'] },
    ] }));
    const [iran, china] = await harness.fetchGdeltTensions();
    assert.deepEqual(iran?.evidence, [
      { channel: 'military_aircraft', value: 9, baseline: 2.21, countries: ['US'], airports: [] },
      { channel: 'airports', value: 1, baseline: null, countries: [], airports: [{ name: 'Tehran Imam Khomeini', status: 'closed' }] },
    ]);
    assert.deepEqual(china?.evidence, []);
  });
});
