// Iran-events domain sunset (war ended 2026-07) — flag-gated, default OFF.
//
// Frontend flag: VITE_ENABLE_IRAN_ATTACKS (guarded by isClientRuntime, so under
// node:test — where `window` is undefined — it always resolves OFF, which is
// exactly the shipped default). These tests therefore assert the sunset default:
// the layer is hidden from the picker, stripped from any restored MapLayers, and
// skipped by CMD+K. Backend gates (edge/script modules that can't be imported
// under node:test) are covered by source-text guards.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LAYER_REGISTRY,
  getLayersForVariant,
  getAllowedLayerKeys,
  isLayerExecutable,
  sanitizeLayersForVariant,
} from '../src/config/map-layer-definitions';
import { buildForecastInputFetchKeys } from '../scripts/seed-forecasts.mjs';
import { resolveBootstrapRegistry } from '../shared/bootstrap-tier-keys.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(resolve(repoRoot, p), 'utf8');

describe('iran-events sunset — frontend map layer (default OFF)', () => {
  it('is registered but excluded from the variant layer picker', () => {
    assert.ok(LAYER_REGISTRY.iranAttacks, 'registry entry is kept for re-enable');
    const defs = getLayersForVariant('full', 'flat');
    assert.ok(!defs.includes(LAYER_REGISTRY.iranAttacks), 'iranAttacks must not appear in the picker while sunset');
  });

  it('is dropped from the allowed keys and stripped from restored MapLayers', () => {
    assert.ok(!getAllowedLayerKeys('full').has('iranAttacks'), 'iranAttacks must not be an allowed key while sunset');
    // A URL/storage-restored layer set with iranAttacks:true is forced off.
    const sanitized = sanitizeLayersForVariant({ iranAttacks: true, conflicts: true } as never, 'full');
    assert.equal((sanitized as Record<string, boolean>).iranAttacks, false, 'restored iranAttacks:true must be stripped to false');
    assert.equal((sanitized as Record<string, boolean>).conflicts, true, 'unrelated layers are untouched');
  });

  it('is not executable (CMD+K / picker toggles silently skip it)', () => {
    assert.equal(isLayerExecutable('iranAttacks', 'flat', true), false);
  });
});

describe('iran-events sunset — backend gates (source guards)', () => {
  it('health.js drops iranEvents from SEED_META + BOOTSTRAP_KEYS when disabled', () => {
    const src = read('api/health.js');
    assert.match(src, /IRAN_EVENTS_ENABLED = \(process\.env\.IRAN_EVENTS_ENABLED/);
    assert.match(src, /if \(!IRAN_EVENTS_ENABLED\) \{[\s\S]*?delete BOOTSTRAP_KEYS\.iranEvents;[\s\S]*?delete SEED_META\.iranEvents;/);
  });

  it('seed-health.js drops the conflict:iran-events domain when disabled', () => {
    assert.match(read('api/seed-health.js'), /IRAN_EVENTS_ENABLED[\s\S]*?delete SEED_DOMAINS\['conflict:iran-events'\]/);
  });

  it('bootstrap.js omits iranEvents from the payload + fast tier when disabled', () => {
    const src = read('api/bootstrap.js');
    assert.match(src, /resolveBootstrapRegistry\(\{\s*iranEventsEnabled:\s*IRAN_EVENTS_ENABLED/);
    const disabled = resolveBootstrapRegistry({ iranEventsEnabled: false });
    assert.equal(disabled.cacheKeys.iranEvents, undefined);
    assert.equal(disabled.tiers.iranEvents, undefined);
    const enabled = resolveBootstrapRegistry({ iranEventsEnabled: true });
    assert.equal(enabled.cacheKeys.iranEvents, 'conflict:iran-events:v1');
    assert.equal(enabled.tiers.iranEvents, 'fast');
  });

  it('get-risk-scores.ts gates the iran-events fetch (no CII/risk contribution)', () => {
    assert.match(read('server/worldmonitor/intelligence/v1/get-risk-scores.ts'), /IRAN_EVENTS_ENABLED \? getCachedJson\('conflict:iran-events:v1'/);
  });

  it('seed-forecasts.mjs feeds empty iranEvents when disabled', () => {
    assert.match(read('scripts/seed-forecasts.mjs'), /iranEvents: iranEventsEnabled\(\) \? parsedByKey\['conflict:iran-events:v1'\] : \[\]/);
  });

  it('seed-iran-events.mjs no-ops (exit 0) when disabled', () => {
    assert.match(read('scripts/seed-iran-events.mjs'), /IRAN_EVENTS_ENABLED[\s\S]*?process\.exit\(0\)/);
  });

  // ce-code-review #4982 follow-ups — parallel API/MCP surfaces that also read
  // the shared cache key must be gated, not just api/bootstrap.js.

  it('get-bootstrap-data RPC drops iranEvents from the shared bootstrap registry', () => {
    assert.match(read('server/worldmonitor/infrastructure/v1/get-bootstrap-data.ts'), /if \(!IRAN_EVENTS_ENABLED\) delete registry\.iranEvents/);
  });

  it('list-iran-events RPC serves empty immediately when disabled (not the 14d-TTL snapshot)', () => {
    assert.match(read('server/worldmonitor/conflict/v1/list-iran-events.ts'), /if \(!IRAN_EVENTS_ENABLED\) return \{ events: \[\], scrapedAt: '0' \}/);
  });

  it('MCP get_conflict_events drops the iran-events cache key when disabled', () => {
    assert.match(read('api/mcp/registry/cache-tools.ts'), /\.\.\.\(IRAN_EVENTS_ENABLED \? \['conflict:iran-events:v1'\] : \[\]\)/);
  });

  it('seed-forecasts.mjs skips fetching the iran key into the pipeline batch when disabled', () => {
    const previousIranEventsEnabled = process.env.IRAN_EVENTS_ENABLED;
    delete process.env.IRAN_EVENTS_ENABLED;
    try {
      assert.ok(!buildForecastInputFetchKeys().includes('conflict:iran-events:v1'));
      process.env.IRAN_EVENTS_ENABLED = 'true';
      assert.ok(buildForecastInputFetchKeys().includes('conflict:iran-events:v1'));
    } finally {
      if (previousIranEventsEnabled === undefined) delete process.env.IRAN_EVENTS_ENABLED;
      else process.env.IRAN_EVENTS_ENABLED = previousIranEventsEnabled;
    }

    assert.match(read('scripts/seed-forecasts.mjs'), /const keys = buildForecastInputFetchKeys\(\);/);
  });
});
