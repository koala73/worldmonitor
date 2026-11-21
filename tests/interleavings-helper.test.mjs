import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createModelRedis, exploreInterleavings, upstashFetch } from './helpers/interleavings.mjs';

const URL_BASE = 'https://model.redis';

function command(fetch, ...parts) {
  return fetch(`${URL_BASE}/`, { method: 'POST', body: JSON.stringify(parts) }).then((r) => r.json());
}

describe('exploreInterleavings', () => {
  it('starts an actor whose prerequisites finished without making a request', async () => {
    const order = [];
    const actor = (name, after) => ({ name, after, start: async () => { order.push(name); } });
    const result = await exploreInterleavings({
      setup: () => ({}),
      actors: [actor('a'), actor('b', ['a']), actor('c', ['b'])],
      check: () => null,
    });
    assert.equal(result.violation, null);
    assert.deepEqual(order, ['a', 'b', 'c']);
  });

  it('reports actors that write different values on replay as nondeterministic', async () => {
    let runs = 0;
    await assert.rejects(exploreInterleavings({
      setup: (run) => {
        runs += 1;
        return { fetch: upstashFetch(run, createModelRedis()), value: String(runs) };
      },
      // The replay of a later order repeats a's first write with a new value.
      actors: [
        { name: 'a', start: async (w) => { await command(w.fetch, 'SET', 'k', w.value); await command(w.fetch, 'SET', 'k', 'again'); } },
        { name: 'b', start: (w) => command(w.fetch, 'GET', 'k') },
      ],
      check: () => null,
    }), /not deterministic/);
  });

  it('schedules a multi-key command when any of its keys is shared', async () => {
    const result = await exploreInterleavings({
      setup: (run) => ({ fetch: upstashFetch(run, createModelRedis({ shared: 'x' }), { isShared: (key) => key === 'shared' }) }),
      actors: [
        { name: 'deleter', start: (w) => command(w.fetch, 'DEL', 'private', 'shared') },
        { name: 'reader', start: (w) => command(w.fetch, 'GET', 'shared') },
      ],
      check: (_w, outcomes) => (outcomes.reader.value.result === 'x' ? 'the read ran before the delete' : null),
    });
    assert.notEqual(result.violation, null, 'the read can run before the delete, so the explorer must try that order');
  });
});

describe('createModelRedis SCAN', () => {
  it('can return an empty page before the cursor ends, and finds keys on later pages', () => {
    const redis = createModelRedis({ 'a:other': '1', 'b:one': '1', 'b:two': '1' }, { scanCount: 1 });
    const pages = [];
    let cursor = '0';
    do {
      const [next, keys] = redis.cell(['SCAN', cursor, 'MATCH', 'b:*', 'COUNT', '100']).result;
      pages.push(keys);
      cursor = next;
    } while (cursor !== '0');
    assert.deepEqual(pages, [[], ['b:one'], ['b:two']]);
  });

  it('returns every key that exists for the whole scan, even when earlier keys are deleted', () => {
    const redis = createModelRedis({ 'b:1': '1', 'b:2': '1', 'b:3': '1' }, { scanCount: 1 });
    const seen = [];
    let cursor = '0';
    do {
      const [next, keys] = redis.cell(['SCAN', cursor, 'MATCH', 'b:*']).result;
      for (const key of keys) { seen.push(key); redis.cell(['DEL', key]); }
      cursor = next;
    } while (cursor !== '0');
    assert.deepEqual(seen, ['b:1', 'b:2', 'b:3']);
  });
});
