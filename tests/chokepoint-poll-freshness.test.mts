import { afterEach, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type PluginBuild } from 'esbuild';

import { REFRESH_INTERVALS } from '../src/config/variants/base.ts';

// The strip polls on REFRESH_INTERVALS.chokepointStrip with the poll loop's
// default ±10% jitter, so two polls can land 0.9 intervals apart. A reading
// published between them must appear on the next poll.
const SHORTEST_JITTERED_POLL_MS = REFRESH_INTERVALS.chokepointStrip * 0.9;

type Status = { chokepoints: Array<{ id: string }>; fetchedAt: string; upstreamUnavailable: boolean };
type Harness = { fetchChokepointStatus: () => Promise<Status> };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let harness: Harness;

const stubBrowserSeams = {
  name: 'stub-browser-seams',
  setup(b: PluginBuild) {
    b.onResolve({ filter: /services\/panel-gating/ }, () => ({ path: 'stub:panel-gating', namespace: 'stub-seam' }));
    b.onResolve({ filter: /services\/premium-fetch/ }, () => ({ path: 'stub:premium-fetch', namespace: 'stub-seam' }));
    b.onResolve({ filter: /services\/i18n/ }, () => ({ path: 'stub:i18n', namespace: 'stub-seam' }));
    b.onLoad({ filter: /.*/, namespace: 'stub-seam' }, (args) => ({
      contents: args.path === 'stub:panel-gating'
        ? 'export function hasPremiumAccess() { return false; }'
        : args.path === 'stub:premium-fetch'
          ? 'export async function premiumFetch(...args) { return globalThis.fetch(...args); }'
          : "export function t(key) { return key; } export function getCurrentLanguageTag() { return 'en'; }",
      loader: 'js',
    }));
  },
};

before(async () => {
  const result = await build({
    stdin: {
      contents: "export { fetchChokepointStatus } from './src/services/supply-chain/index.ts';",
      loader: 'ts',
      resolveDir: root,
      sourcefile: 'chokepoint-poll-freshness-entry.ts',
    },
    bundle: true,
    define: { 'import.meta.env': '{"DEV":false}' },
    format: 'esm',
    logLevel: 'silent',
    platform: 'node',
    target: 'node20',
    write: false,
    plugins: [stubBrowserSeams],
  });
  const source = result.outputFiles[0]?.text;
  assert.ok(source, 'esbuild must emit the chokepoint harness');
  harness = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`) as Harness;
});

function status(id: string): Status {
  return { chokepoints: [{ id }], fetchedAt: new Date(0).toISOString(), upstreamUnavailable: false };
}

afterEach(() => mock.restoreAll());

describe('chokepoint strip polling freshness', () => {
  it('shows a reading published since the last poll on the next poll, even when jitter shortens the gap', async () => {
    let served = status('first');
    mock.method(globalThis, 'fetch', async () => Response.json(served));
    let now = Date.parse('2026-10-18T06:00:00Z');
    mock.method(Date, 'now', () => now);

    assert.equal((await harness.fetchChokepointStatus()).chokepoints[0]?.id, 'first');

    served = status('new');
    now += SHORTEST_JITTERED_POLL_MS;
    assert.equal((await harness.fetchChokepointStatus()).chokepoints[0]?.id, 'new', 'the next poll shows the new reading');
  });
});
