import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const registry = JSON.parse(readFileSync(
  new URL('../scripts/shared/comtrade-transit-hubs.json', import.meta.url),
  'utf8',
));
const briefSource = readFileSync(
  new URL('../src/utils/decision-brief.ts', import.meta.url),
  'utf8',
);

describe('reviewed Comtrade transit-hub registry', () => {
  it('has one versioned, provenance-bearing row per flagged origin', () => {
    assert.equal(registry.schemaVersion, 1);
    assert.match(registry.reviewedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(registry.note.length > 0);
    assert.ok(Array.isArray(registry.hubs));
    // The cohort is a reviewed judgement, so the floor guards against a future
    // edit silently emptying the list and turning the hub flag into dead code.
    assert.ok(registry.hubs.length >= 5, `expected at least 5 hubs, got ${registry.hubs.length}`);
    assert.equal(new Set(registry.hubs.map((hub) => hub.iso2)).size, registry.hubs.length);
    for (const hub of registry.hubs) {
      assert.match(hub.iso2, /^[A-Z]{2}$/);
      assert.ok(hub.label.length > 0, hub.iso2);
      assert.ok(hub.rationale.length > 0, hub.iso2);
      assert.match(hub.sourceUrl, /^https:\/\//);
    }
  });

  it('flags only codes the brief can name back to the reader', () => {
    // The brief renders origins through Intl.DisplayNames; a code it cannot
    // resolve would print the raw ISO2 next to a "possible transit hub" badge.
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    for (const hub of registry.hubs) {
      const resolved = names.of(hub.iso2);
      assert.ok(resolved && resolved !== hub.iso2, `${hub.iso2} does not resolve to a region name`);
    }
  });

  it('is consumed by the brief builder, not just stored', () => {
    assert.match(briefSource, /comtrade-transit-hubs\.json/);
  });
});
