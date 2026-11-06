import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { transformSync } from 'esbuild';
import { classifyByKeyword as classifyShared } from '../shared/threat-keyword-classifier.ts';
import { classifyByKeyword as classifyServer } from '../server/worldmonitor/news/v1/_classifier.ts';

test('keyword and callsign lookups reuse patterns compiled during module initialization', async () => {
  const { code } = transformSync(readFileSync(new URL('../src/config/military.ts', import.meta.url), 'utf8'), {
    loader: 'ts', format: 'esm', define: { 'import.meta.env.DEV': 'false' },
  });
  const { identifyByCallsign } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  const original = globalThis.RegExp;
  globalThis.RegExp = new Proxy(original, {
    construct() { throw new Error('Lookup compiled a regex after module initialization'); },
    apply() { throw new Error('Lookup compiled a regex after module initialization'); },
  });
  try {
    for (let repeat = 0; repeat < 2; repeat++) {
      for (const classify of [classifyShared, classifyServer]) {
        assert.equal(classify('Nuclear strike reported').level, 'critical');
        assert.equal(classify('war begins').level, 'high');
        assert.equal(classify('Markets rally today').level, 'info');
      }
      assert.equal(identifyByCallsign('RCH123')?.operator, 'usaf');
      assert.equal(identifyByCallsign('NAVY123', 'united states')?.operator, 'usn');
      assert.equal(identifyByCallsign('NAVY123', 'united kingdom')?.operator, 'rn');
      assert.equal(identifyByCallsign('UNKNOWN')?.operator, undefined);
    }
  } finally {
    globalThis.RegExp = original;
  }
});
