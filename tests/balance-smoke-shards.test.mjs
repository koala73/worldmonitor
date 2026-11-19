import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  estimateSpecs,
  median,
  packShards,
  readSmokeScripts,
  rewriteShardScripts,
  shardLoads,
  specSecondsFromLog,
} from '../scripts/balance-smoke-shards.mjs';

const ESC = '\x1b';
const dim = (text) => `${ESC}[2m${text}${ESC}[22m`;
const ts = (seconds) => `2026-11-09T07:32:${String(seconds).padStart(2, '0')}.7278869Z `;

const LOG = [
  `${ts(1)}Running 7 tests using 2 workers`,
  `${ts(2)}  ${ESC}[32m✓${ESC}[39m    1 [chromium] › e2e/a.spec.ts:10:3 › suite › renders (28.2s)`,
  `${ts(3)}  ✓    2 [chromium] › e2e/a.spec.ts:20:3 › suite › tooltip (opens) ${dim('(640ms)')}`,
  `${ts(4)}  ${ESC}[31m✘${ESC}[39m    3 [chromium] › e2e/b.spec.ts:5:1 › flaky ${ESC}[31mmap${ESC}[39m (12.0s)`,
  `${ts(5)}  ✓    4 [chromium] › e2e/b.spec.ts:5:1 › flaky map ${ESC}[33m (retry #1)${ESC}[39m${dim(' (8.5s)')}`,
  `${ts(6)}  ✓    5 [chromium] › e2e/c.spec.ts:1:1 › long @slow (1.5m)`,
  `${ts(7)}  -    6 [chromium] › e2e/c.spec.ts:9:1 › skipped`,
  `${ts(8)}2026-11-09T07:32:27.656Z pw:browser [pid=2706][err] e2e/a.spec.ts:1:1 › noise (5.0s)`,
  `${ts(9)}  102 passed (4.7m)`,
].join('\n');

describe('specSecondsFromLog', () => {
  it('sums ms, s and m results per spec file, counting failed attempts and retries', () => {
    assert.deepEqual(
      Object.fromEntries(specSecondsFromLog(LOG)),
      { 'e2e/a.spec.ts': 28_840, 'e2e/b.spec.ts': 20_500, 'e2e/c.spec.ts': 90_000 },
    );
  });

  it('reads lines without an Actions timestamp', () => {
    const local = '  ✓  12 [chromium] › e2e/map-distance.spec.ts:59:3 › title (28.2s)';
    assert.deepEqual(Object.fromEntries(specSecondsFromLog(local)), { 'e2e/map-distance.spec.ts': 28_200 });
  });

  it('returns nothing for a log without list-reporter results', () => {
    assert.equal(specSecondsFromLog(`${ts(1)}npm ci\n${ts(2)}  102 passed (4.7m)`).size, 0);
  });
});

describe('median', () => {
  it('takes the middle value, or the rounded mean of the two middles', () => {
    assert.equal(median([300, 100, 200]), 200);
    assert.equal(median([400, 100, 301, 200]), 251);
    assert.throws(() => median([]));
  });
});

describe('estimateSpecs', () => {
  it('uses each spec median across the runs that measured it and flags unmeasured specs', () => {
    const runs = [
      new Map([['e2e/a.spec.ts', 10_000], ['e2e/b.spec.ts', 2_000]]),
      new Map([['e2e/a.spec.ts', 30_000], ['e2e/b.spec.ts', 4_000], ['e2e/gone.spec.ts', 9_000]]),
      new Map([['e2e/a.spec.ts', 20_000]]),
    ];
    const estimates = estimateSpecs(['e2e/a.spec.ts', 'e2e/b.spec.ts', 'e2e/new.spec.ts'], runs);
    assert.deepEqual([...estimates.keys()], ['e2e/a.spec.ts', 'e2e/b.spec.ts', 'e2e/new.spec.ts']);
    assert.deepEqual(estimates.get('e2e/a.spec.ts'), { ms: 20_000, samples: [10_000, 30_000, 20_000], estimated: false });
    assert.deepEqual(estimates.get('e2e/b.spec.ts'), { ms: 3_000, samples: [2_000, 4_000], estimated: false });
    assert.deepEqual(estimates.get('e2e/new.spec.ts'), { ms: 11_500, samples: [], estimated: true });
  });
});

const spec = (name) => `e2e/${name}.spec.ts`;
const SKEWED = new Map([
  [spec('h1'), 10_000], [spec('h2'), 10_000], [spec('h3'), 10_000], [spec('h4'), 10_000],
  [spec('l1'), 5_000], [spec('l2'), 5_000], [spec('l3'), 5_000], [spec('l4'), 5_000],
]);
const SKEWED_SPECS = [...SKEWED.keys()];
const SKEWED_CURRENT = [
  [spec('h1'), spec('h2'), spec('h3'), spec('h4')],
  [spec('l1')],
  [spec('l2'), spec('l3')],
  [spec('l4')],
];

const assertPartition = (shards, specs) => {
  assert.deepEqual(shards.flat().sort(), [...specs].sort(), 'every spec lands in exactly one shard');
  assert.ok(shards.every((shard) => shard.length > 0), 'no shard is empty');
};

describe('packShards', () => {
  it('lowers the largest shard of a skewed split to the optimum without losing a spec', () => {
    assert.equal(Math.max(...shardLoads(SKEWED_CURRENT, SKEWED)), 40_000);
    const shards = packShards(SKEWED_SPECS, SKEWED, 4, SKEWED_CURRENT);
    assertPartition(shards, SKEWED_SPECS);
    assert.deepEqual(shardLoads(shards, SKEWED), [15_000, 15_000, 15_000, 15_000]);
  });

  it('beats a plain longest-first split where that leaves a shard heavy', () => {
    // Longest-first puts 3+2+2 against 3+2; only a swap reaches 6/6.
    const msBySpec = new Map([
      [spec('a'), 3_000], [spec('b'), 3_000], [spec('c'), 2_000], [spec('d'), 2_000], [spec('e'), 2_000],
    ]);
    const shards = packShards([...msBySpec.keys()], msBySpec, 2);
    assertPartition(shards, [...msBySpec.keys()]);
    assert.deepEqual(shardLoads(shards, msBySpec), [6_000, 6_000]);
  });

  it('places specs missing from the current split and drops none', () => {
    const current = [[spec('h1')], [spec('h2')], [spec('h3')], [spec('h4')]];
    const shards = packShards(SKEWED_SPECS, SKEWED, 4, current);
    assertPartition(shards, SKEWED_SPECS);
    assert.deepEqual(shardLoads(shards, SKEWED), [15_000, 15_000, 15_000, 15_000]);
  });

  it('is deterministic whatever order the specs and durations arrive in', () => {
    const reversed = new Map([...SKEWED].reverse());
    const first = packShards(SKEWED_SPECS, SKEWED, 4, SKEWED_CURRENT);
    assert.deepEqual(packShards([...SKEWED_SPECS].reverse(), reversed, 4, SKEWED_CURRENT), first);
    assert.deepEqual(packShards(SKEWED_SPECS, SKEWED, 4, SKEWED_CURRENT), first);
    for (const shard of first) assert.deepEqual(shard, [...shard].sort(), 'specs within a shard are sorted');
  });

  it('keeps a split that is already within 1% of the best max', () => {
    const msBySpec = new Map([
      [spec('a'), 10_000], [spec('b'), 10_050], [spec('c'), 9_950], [spec('d'), 10_000],
      [spec('e'), 1_000], [spec('f'), 1_000], [spec('g'), 1_000], [spec('h'), 1_000],
    ]);
    const current = [[spec('a'), spec('e')], [spec('b'), spec('f')], [spec('c'), spec('g')], [spec('d'), spec('h')]];
    assert.deepEqual(packShards([...msBySpec.keys()], msBySpec, 4, current), current);
  });

  it('refuses fewer specs than shards', () => {
    assert.throws(() => packShards([spec('a')], new Map([[spec('a'), 1]]), 4));
  });
});

const PREFIX = 'cross-env VITE_VARIANT=full playwright test';
const PACKAGE_TEXT = `${JSON.stringify(
  {
    name: 'fixture',
    scripts: {
      build: 'vite build',
      'test:e2e:ci-smoke': `${PREFIX} e2e/a.spec.ts e2e/b.spec.ts e2e/c.spec.ts`,
      'test:e2e:ci-smoke:1': `${PREFIX} e2e/a.spec.ts e2e/b.spec.ts`,
      'test:e2e:ci-smoke:2': `${PREFIX} e2e/c.spec.ts --retries=1`,
      'test:e2e:other': `${PREFIX} e2e/a.spec.ts e2e/b.spec.ts`,
    },
  },
  null,
  2,
)}\n`;

describe('readSmokeScripts', () => {
  it('reads the combined inventory and the shard lists in shard order', () => {
    assert.deepEqual(readSmokeScripts(JSON.parse(PACKAGE_TEXT).scripts), {
      specs: ['e2e/a.spec.ts', 'e2e/b.spec.ts', 'e2e/c.spec.ts'],
      shardNames: ['test:e2e:ci-smoke:1', 'test:e2e:ci-smoke:2'],
      shards: [['e2e/a.spec.ts', 'e2e/b.spec.ts'], ['e2e/c.spec.ts']],
    });
  });

  it('rejects a shard spec that the combined command does not run', () => {
    const scripts = { ...JSON.parse(PACKAGE_TEXT).scripts, 'test:e2e:ci-smoke:2': `${PREFIX} e2e/d.spec.ts` };
    assert.throws(() => readSmokeScripts(scripts), /e2e\/d\.spec\.ts/);
  });
});

describe('rewriteShardScripts', () => {
  it('replaces only the shard spec lists, keeping prefixes, trailing options, key order and layout', () => {
    const shards = [['e2e/b.spec.ts'], ['e2e/a.spec.ts', 'e2e/c.spec.ts']];
    const text = rewriteShardScripts(PACKAGE_TEXT, ['test:e2e:ci-smoke:1', 'test:e2e:ci-smoke:2'], shards);
    const expected = JSON.parse(PACKAGE_TEXT);
    expected.scripts['test:e2e:ci-smoke:1'] = `${PREFIX} e2e/b.spec.ts`;
    expected.scripts['test:e2e:ci-smoke:2'] = `${PREFIX} e2e/a.spec.ts e2e/c.spec.ts --retries=1`;
    assert.equal(text, `${JSON.stringify(expected, null, 2)}\n`);
  });
});
