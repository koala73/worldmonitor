import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const refsSrc = readFileSync(join(root, 'server', 'worldmonitor', '_bootstrap-cache-key-refs.ts'), 'utf8');
const bootstrapSrc = readFileSync(join(root, 'api', 'bootstrap.js'), 'utf8');
const healthSrc = readFileSync(join(root, 'api', 'health.js'), 'utf8');

describe('resilience bootstrap and health registration', () => {
  it('keeps canonical resilience key refs outside the public bootstrap registry', () => {
    assert.match(refsSrc, /resilienceScoreUs:\s+'resilience:score:US'/);
    assert.match(refsSrc, /resilienceRanking:\s+'resilience:ranking'/);
    assert.doesNotMatch(bootstrapSrc, /resilience:score:US/);
    assert.doesNotMatch(bootstrapSrc, /resilience:ranking/);
  });

  it('registers resilience ranking freshness in health.js as an on-demand key', () => {
    assert.match(healthSrc, /resilienceRanking:\s+'resilience:ranking'/);
    assert.match(healthSrc, /resilienceRanking:\s+\{ key: 'seed-meta:resilience:ranking',\s+maxStaleMin: 720 \}/);
    assert.match(healthSrc, /'resilienceRanking', \/\/ on-demand RPC cache populated after ranking requests; missing before first Pro use is expected/);
  });
});
