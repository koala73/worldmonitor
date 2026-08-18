import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const appSource = readFileSync(new URL('../src/App.ts', import.meta.url), 'utf8');
const start = appSource.indexOf('private ensureSearchManager(): Promise<SearchManager> {');
const end = appSource.indexOf('\n  private updateSearchIndexIfReady(): void {', start);
assert.ok(start >= 0, 'App must retain the lazy search-manager loader');
assert.ok(end > start, 'lazy search-manager loader boundary must remain discoverable');
const ensureSearchManager = appSource.slice(start, end);

describe('lazy search-manager startup', () => {
  it('publishes the manager without awaiting optional source hydration', () => {
    assert.match(ensureSearchManager, /manager\.init\(\);/);
    assert.doesNotMatch(
      ensureSearchManager,
      /await manager\.whenSearchIndexReady\(\)/,
      'optional military-base hydration must not block CMD+K startup',
    );
    assert.match(ensureSearchManager, /this\.searchManager = manager;/);
  });
});
