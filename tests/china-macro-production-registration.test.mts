import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BOOTSTRAP_CACHE_KEYS } from '../shared/bootstrap-tier-keys.js';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('China macro production registration', () => {
  it('schedules both seeders in the Railway macro bundle', () => {
    const source = read('scripts/seed-bundle-macro.mjs');
    assert.match(source, /script:\s*'seed-china-macro\.mjs'/);
    assert.match(source, /script:\s*'seed-china-release-calendar\.mjs'/);
    assert.match(source, /intervalMs:\s*36 \* HOUR/);
  });

  it('activates both predeclared China coverage lanes with content-age anchoring', () => {
    const source = read('scripts/china-coverage-manifest.mjs');
    assert.match(source, /id:\s*'macro\.china-snapshot'[\s\S]*?launchStatus:\s*'launched'[\s\S]*?contentObservationDate/);
    assert.match(source, /id:\s*'macro\.china-release-calendar'[\s\S]*?launchStatus:\s*'launched'/);
    assert.match(source, /id:\s*'macro\.china-release-calendar'[\s\S]*?timestampPaths:\s*\[\['generatedAt'\]\]/);
  });

  it('registers bootstrap, health, seed-health, cache-key, and slow gateway surfaces', () => {
    assert.equal(BOOTSTRAP_CACHE_KEYS.chinaMacro, 'economic:china:macro:v1');
    assert.equal(BOOTSTRAP_CACHE_KEYS.chinaReleaseCalendar, 'economic:china:release-calendar:v1');
    assert.match(read('api/health.js'), /chinaMacro:\s*\{ key: 'seed-meta:economic:china-macro'/);
    assert.match(read('api/health.js'), /chinaMacro:\s*\{[^\n]*maxStaleMin:\s*4_320/);
    assert.match(read('api/seed-health.js'), /'economic:china-macro'/);
    assert.match(read('server/_shared/cache-keys.ts'), /CHINA_MACRO_KEY\s*=\s*'economic:china:macro:v1'/);
    assert.match(read('server/gateway.ts'), /'\/api\/economic\/v1\/get-china-macro-snapshot':\s*'slow'/);
  });

  it('exposes the snapshot through the economic MCP cache tool and public API path', () => {
    const source = read('api/mcp/registry/cache-tools.ts');
    assert.match(source, /'economic:china:macro:v1'/);
    assert.match(source, /'economic:china:release-calendar:v1'/);
    assert.match(source, /GET \/api\/economic\/v1\/get-china-macro-snapshot/);
  });
});
