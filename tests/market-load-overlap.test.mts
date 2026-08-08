import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { LatestRequestGuard } from '../src/utils/latest-request-guard.ts';

describe('market load overlap guard', () => {
  it('suppresses stale batch/final writes', async () => {
    const guard = new LatestRequestGuard();
    const writes: string[] = [];
    let releaseOld!: () => void;

    const run = async (name: string, wait?: Promise<void>) => {
      const generation = guard.begin();
      if (wait) await wait;
      if (guard.isCurrent(generation)) writes.push(`${name}:batch`);
      await Promise.resolve();
      if (guard.isCurrent(generation)) writes.push(`${name}:final`);
      return guard.isCurrent(generation);
    };

    const oldWait = new Promise<void>((resolve) => { releaseOld = resolve; });
    const old = run('old-selection', oldWait);
    const current = run('new-selection');
    releaseOld();

    assert.equal(await current, true);
    assert.equal(await old, false);
    assert.deepEqual(writes, ['new-selection:batch', 'new-selection:final']);
  });

  it('guards the real Markets batch/final writes without suppressing premium refreshes', () => {
    const source = readFileSync(new URL('../src/app/data-loader.ts', import.meta.url), 'utf8');
    assert.match(source, /const generation = this\.marketLoadGuard\.begin\(\)/);
    assert.match(source, /onBatch: \(partialStocks\) => \{\s*if \(!isCurrent\(\)\) return;[\s\S]*?renderMarkets\(partialStocks\)/);
    assert.match(source, /if \(isCurrent\(\)\) \{\s*this\.ctx\.latestMarkets = stocksResult\.data;\s*marketsPanel\?\.renderMarkets\(stocksResult\.data/);
    assert.match(source, /this\.loadMarkets\(\)\.then\(async \(\) =>/);
    assert.doesNotMatch(source, /then\(async \(applied\) =>/);
  });
});
