/**
 * Mission conversion funnel — Release 0 instrumentation
 * (ONBOARDING_STRATEGY.md, plan 2026-08-30-001, U1/U8).
 *
 * Contract under test:
 *  1. The event vocabulary is pinned — renaming a funnel event breaks a test
 *     here, not a dashboard silently.
 *  2. `panel-viewed` fires once per panel per tab session (KTD5): the second
 *     view of the same panel emits nothing, and the dedupe survives a page
 *     reload via sessionStorage.
 *  3. Every funnel event carries variant + device class; mission id rides
 *     along when a preset is active and is absent otherwise.
 *  4. Ids travelling to Umami are bucketed against closed vocabularies —
 *     crafted mission ids / panel keys collapse to 'unknown' (the
 *     bucketProductIdForAnalytics rule, applied to the new fields).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

class MemoryStorage {
  private readonly store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

type TrackedCall = { name: string; data?: Record<string, unknown> };

function installWindow(opts: { innerWidth?: number; sessionStorage?: MemoryStorage } = {}): {
  calls: TrackedCall[];
  sessionStorage: MemoryStorage;
  localStorage: MemoryStorage;
} {
  const calls: TrackedCall[] = [];
  const sessionStorage = opts.sessionStorage ?? new MemoryStorage();
  const localStorage = new MemoryStorage();
  const fakeWindow: Record<string, unknown> = {
    sessionStorage,
    localStorage,
    innerWidth: opts.innerWidth ?? 1280,
    umami: {
      track: (name: string, data?: Record<string, unknown>) => calls.push({ name, data }),
      identify: () => {},
    },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  // mission-presets reads the bare `localStorage` global, not window.localStorage.
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
  return { calls, sessionStorage, localStorage };
}

function cleanupWindow(): void {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { localStorage?: unknown }).localStorage;
}

const FUNNEL_EVENTS = [
  'mission-picker-shown',
  'mission-selected',
  'panel-viewed',
  'pro-preview-viewed',
  'pro-preview-cta',
  'pro-preview-dismissed',
  'mission-returned-after-purchase',
] as const;

describe('funnel event vocabulary (U8)', () => {
  it('pins every mission-funnel event in the typed EVENTS catalog', () => {
    const src = read('src/services/analytics.ts');
    for (const ev of FUNNEL_EVENTS) {
      assert.ok(src.includes(`'${ev}': true`), `event '${ev}' missing from EVENTS catalog`);
    }
  });

  it('documents every funnel event in docs/analytics/mission-funnel-events.md', () => {
    const doc = read('docs/analytics/mission-funnel-events.md');
    for (const ev of FUNNEL_EVENTS) {
      assert.ok(doc.includes(`\`${ev}\``), `event '${ev}' missing from the funnel reference doc`);
    }
  });
});

describe('panel-viewed session dedupe (KTD5)', () => {
  afterEach(cleanupWindow);

  it('fires once per panel; a second view of the same panel emits nothing', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const { calls } = installWindow();
    analytics.resetMissionFunnelAnalyticsForTesting();

    analytics.trackPanelView('cii');
    analytics.trackPanelView('cii');
    analytics.trackPanelView('economic');

    const panelEvents = calls.filter((c) => c.name === 'panel-viewed');
    assert.equal(panelEvents.length, 2, 'same panel must not re-fire within a session');
    assert.equal(panelEvents[0]!.data!.panelKey, 'cii');
    assert.equal(panelEvents[1]!.data!.panelKey, 'economic');
  });

  it('persists the dedupe in sessionStorage so a reload does not re-fire', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const shared = new MemoryStorage();
    installWindow({ sessionStorage: shared });
    analytics.resetMissionFunnelAnalyticsForTesting();
    analytics.trackPanelView('cii');
    cleanupWindow();

    // Simulated reload: fresh window + fresh in-memory state, same per-tab
    // sessionStorage. keepSession clears only the memory set — clearing
    // sessionStorage too would erase the very state under test.
    const { calls } = installWindow({ sessionStorage: shared });
    analytics.resetMissionFunnelAnalyticsForTesting({ keepSession: true });
    analytics.trackPanelView('cii');
    assert.equal(
      calls.filter((c) => c.name === 'panel-viewed').length,
      0,
      'reload must not re-emit a panel already viewed this tab session',
    );
  });
});

describe('funnel context fields', () => {
  afterEach(cleanupWindow);

  it('panel-viewed carries missionId when a preset is active, omits it when none', async () => {
    const analytics = await import('../src/services/analytics.ts');
    const presets = await import('../src/services/mission-presets.ts');
    analytics.resetAnalyticsForTesting();
    const { calls } = installWindow();
    analytics.resetMissionFunnelAnalyticsForTesting();

    analytics.trackPanelView('economic');
    presets.saveMissionPreset('crisis-desk');
    analytics.trackPanelView('cii');

    const [withoutMission, withMission] = calls.filter((c) => c.name === 'panel-viewed');
    assert.equal('missionId' in withoutMission!.data!, false, 'no mission stored → no missionId field');
    assert.equal(withMission!.data!.missionId, 'crisis-desk');
  });

  it('carries variant and device class on every funnel event', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const { calls } = installWindow({ innerWidth: 500 });
    analytics.resetMissionFunnelAnalyticsForTesting();

    analytics.trackPanelView('cii');
    analytics.trackMissionPickerShown('manual', 'mobile');
    analytics.trackMissionSelected('crisis-desk');

    for (const call of calls) {
      assert.equal(typeof call.data!.variant, 'string', `${call.name} missing variant`);
      assert.equal(call.data!.deviceClass, 'mobile', `${call.name} wrong deviceClass`);
    }
  });

  it('classifies device by the shared mobile breakpoint', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const { calls } = installWindow({ innerWidth: 1280 });
    analytics.resetMissionFunnelAnalyticsForTesting();
    analytics.trackMissionPickerShown('auto', 'desktop');
    assert.equal(calls[0]!.data!.deviceClass, 'desktop');
  });

  it('keeps the analytics breakpoint literal in sync with MOBILE_BREAKPOINT_PX', () => {
    const analytics = read('src/services/analytics.ts');
    const utils = read('src/utils/index.ts');
    const analyticsBp = analytics.match(/MISSION_FUNNEL_MOBILE_BREAKPOINT_PX = (\d+)/)?.[1];
    const utilsBp = utils.match(/MOBILE_BREAKPOINT_PX = (\d+)/)?.[1];
    assert.ok(analyticsBp && utilsBp, 'breakpoint constants not found');
    assert.equal(analyticsBp, utilsBp, 'analytics deviceClass breakpoint drifted from MOBILE_BREAKPOINT_PX');
  });
});

describe('closed-vocabulary bucketing', () => {
  afterEach(cleanupWindow);

  it('collapses crafted mission ids and malformed panel keys to "unknown"', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    installWindow();
    assert.equal(analytics.bucketMissionIdForAnalytics('crisis-desk'), 'crisis-desk');
    assert.equal(analytics.bucketMissionIdForAnalytics('evil-injected'), 'unknown');
    assert.equal(analytics.bucketPanelKeyForAnalytics('cii'), 'cii');
    assert.equal(analytics.bucketPanelKeyForAnalytics('__proto__'), 'unknown');
    assert.equal(analytics.bucketPanelKeyForAnalytics('<script>alert(1)</script>'), 'unknown');
    assert.equal(analytics.bucketPanelKeyForAnalytics('a'.repeat(60)), 'unknown');
  });

  it('pins the duplicated mission vocabulary against mission-presets (no drift)', async () => {
    const analytics = await import('../src/services/analytics.ts');
    const presets = await import('../src/services/mission-presets.ts');
    // Every real preset id must pass the analytics bucket unchanged...
    for (const preset of presets.MISSION_PRESETS) {
      assert.equal(analytics.bucketMissionIdForAnalytics(preset.id), preset.id,
        `analytics KNOWN_MISSION_IDS is missing '${preset.id}' — update the duplicated vocabulary`);
    }
    // ...and the duplicated set must not keep ids the catalog dropped.
    const src = read('src/services/analytics.ts');
    const block = src.match(/KNOWN_MISSION_IDS = new Set\(\[([^\]]+)\]\)/)?.[1] ?? '';
    assert.ok(block, 'KNOWN_MISSION_IDS declaration not found — a reformat made this guard vacuous');
    const analyticsIds = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.ok(
      analyticsIds.length >= presets.MISSION_PRESETS.length,
      'extracted fewer ids than the catalog holds — the extraction regex no longer matches the declaration',
    );
    const catalogIds = new Set(presets.MISSION_PRESETS.map((preset) => preset.id));
    for (const id of analyticsIds) {
      assert.ok(catalogIds.has(id as never), `analytics keeps dropped mission id '${id}'`);
    }
    // The duplicated storage key must match the mission-presets export.
    assert.ok(src.includes(`MISSION_PRESET_STORAGE_KEY = '${presets.MISSION_PRESET_STORAGE_KEY}'`),
      'analytics mission storage key drifted from mission-presets');
  });

  it('passes every real panel key in the catalog through the structural guard unchanged', async () => {
    // The registry mixes kebab-case and camelCase ids (gccNews,
    // regionalStartups); a guard that rejects a live key silently collapses
    // that panel's whole funnel row to 'unknown'.
    const analytics = await import('../src/services/analytics.ts');
    const panels = await import('../src/config/panels.ts');
    const keys = new Set<string>(Object.keys(panels.ALL_PANELS));
    for (const variantKeys of Object.values(panels.VARIANT_DEFAULTS)) {
      for (const key of variantKeys) keys.add(key);
    }
    assert.ok(keys.size > 50, `catalog sweep looks vacuous (${keys.size} keys)`);
    for (const key of keys) {
      assert.equal(analytics.bucketPanelKeyForAnalytics(key), key,
        `real panel key '${key}' collapses to 'unknown' — widen PANEL_KEY_PATTERN`);
    }
  });

  it('mission-selected buckets its mission id', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const { calls } = installWindow();
    analytics.resetMissionFunnelAnalyticsForTesting();
    analytics.trackMissionSelected('not-a-real-mission');
    assert.equal(calls[0]!.data!.missionId, 'unknown');
    assert.equal(calls[0]!.data!.source, 'user');
  });

  it('pro-preview helpers bucket both ids and carry the funnel context', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const { calls } = installWindow();
    analytics.resetMissionFunnelAnalyticsForTesting();
    analytics.trackProPreviewViewed('osint-newsroom', 'gdelt-intel');
    analytics.trackProPreviewCta('osint-newsroom', 'gdelt-intel');
    analytics.trackProPreviewDismissed('osint-newsroom', 'gdelt-intel');
    analytics.trackMissionReturnedAfterPurchase('osint-newsroom', 'Crafted Panel!');

    assert.deepEqual(
      calls.map((c) => c.name),
      ['pro-preview-viewed', 'pro-preview-cta', 'pro-preview-dismissed', 'mission-returned-after-purchase'],
    );
    assert.equal(calls[0]!.data!.missionId, 'osint-newsroom');
    assert.equal(calls[0]!.data!.panelKey, 'gdelt-intel');
    assert.equal(calls[3]!.data!.panelKey, 'unknown');
  });
});
