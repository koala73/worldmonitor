import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const eventHandlersSrc = readFileSync(
  resolve(import.meta.dirname, '../src/app/event-handlers.ts'),
  'utf-8',
);

describe('blocked-storage event handlers', () => {
  it('reloads local variant navigation after a guarded storage write', () => {
    assert.match(
      eventHandlersSrc,
      /if \(this\.ctx\.isDesktopApp \|\| options\.isLocalDev\) \{\s*writeStorageValue\('worldmonitor-variant', variant\);\s*window\.location\.reload\(\);/,
    );
  });

  it('reloads layout reset after guarded storage removals', () => {
    const resetLayout = eventHandlersSrc.match(
      /resetLayout: \(\) => \{([\s\S]*?)window\.location\.reload\(\);\s*\},/,
    )?.[1];

    assert.ok(resetLayout, 'resetLayout must reload the page');
    assert.doesNotMatch(resetLayout, /localStorage\./);
    assert.match(resetLayout, /removeStorageValue\(this\.ctx\.PANEL_ORDER_KEY\)/);
    assert.match(resetLayout, /removeStorageValue\('map-height'\)/);
  });
});
