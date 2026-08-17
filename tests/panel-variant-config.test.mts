import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FREE_MAX_PANELS,
  VARIANT_DEFAULTS,
  countFreePanelCapUsage,
  enforceFreePanelLimit,
  getEffectivePanelConfig,
  isFreePanelCapCounted,
  restoreFreeMapPanelAccess,
  restoreProGatedPanels,
  shouldDeferFreeTierEnforcement,
  userSetPanelEnabled,
} from '../src/config/panels.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function src(relPath: string): string {
  return readFileSync(resolve(root, relPath), 'utf-8');
}

describe('variant panel config resolution', () => {
  it('prefers the happy variant config over a duplicate full panel key', () => {
    const giving = getEffectivePanelConfig('giving', 'happy');

    assert.equal(giving.name, 'Global Giving');
    assert.equal(giving.enabled, true);
    assert.equal(giving.priority, 1);
  });

  it('preserves commodity and energy labels for shared supply-chain panels', () => {
    assert.equal(
      getEffectivePanelConfig('supply-chain', 'commodity').name,
      'Supply Chain & Logistics',
    );
    assert.equal(
      getEffectivePanelConfig('supply-chain', 'energy').name,
      'Chokepoints & Routes',
    );
  });

  it('does not inherit full desktop premium metadata for variant-specific supply-chain panels', () => {
    const panels = src('src/config/panels.ts');
    const definitionFor = (variant: string): string => {
      const match = panels.match(new RegExp(`const ${variant}_PANELS[\\s\\S]*?'supply-chain': \\{([^}]*)\\}`));
      assert.ok(match, `${variant}_PANELS must define supply-chain`);
      return match[1] ?? '';
    };

    assert.match(definitionFor('FULL'), /premium:\s*'enhanced'/);
    assert.doesNotMatch(definitionFor('COMMODITY'), /premium:/);
    assert.doesNotMatch(definitionFor('ENERGY'), /premium:/);
    assert.equal(getEffectivePanelConfig('supply-chain', 'commodity').premium, undefined);
    assert.equal(getEffectivePanelConfig('supply-chain', 'energy').premium, undefined);
  });

  it('still falls back to the cross-variant registry for panels outside a variant default set', () => {
    const forecast = getEffectivePanelConfig('forecast', 'happy');

    assert.equal(forecast.name, 'AI Forecasts');
    assert.equal(forecast.enabled, true);
  });

  it('applies variant overrides on top of the variant-specific base config', () => {
    const financeMap = getEffectivePanelConfig('map', 'finance');

    assert.equal(financeMap.name, 'Global Markets Map');
    assert.equal(financeMap.enabled, true);
    assert.equal(financeMap.priority, 1);
  });

  it('keeps the global map available when free-tier defaults are clamped', () => {
    const fullDefaults = Object.fromEntries(
      VARIANT_DEFAULTS.full.map((key) => [key, { ...getEffectivePanelConfig(key, 'full') }]),
    );

    const clamped = enforceFreePanelLimit(fullDefaults, false);

    assert.equal(clamped.map?.enabled, true);
    assert.equal(countFreePanelCapUsage(clamped), FREE_MAX_PANELS);
  });

  it('restores stale over-cap free layouts where the cap disabled the map', () => {
    const fullDefaults = Object.fromEntries(
      VARIANT_DEFAULTS.full.map((key) => [key, { ...getEffectivePanelConfig(key, 'full') }]),
    );
    const stale = enforceFreePanelLimit(fullDefaults, false);
    stale.map = { ...stale.map!, enabled: false };
    const disabledCapPanel = Object.entries(fullDefaults).find(([key, panel]) =>
      isFreePanelCapCounted(key) && panel.enabled && !stale[key]?.enabled
    );
    assert.ok(disabledCapPanel, 'fixture should include a disabled over-cap panel');
    stale[disabledCapPanel[0]] = { ...disabledCapPanel[1], enabled: true };

    const restored = restoreFreeMapPanelAccess(stale);

    assert.equal(stale.map.enabled, false);
    assert.equal(restored.map?.enabled, true);
    assert.equal(countFreePanelCapUsage(restored), FREE_MAX_PANELS + 1);
  });

  it('does not force-enable a manually hidden map when the free layout is exactly at cap', () => {
    const fullDefaults = Object.fromEntries(
      VARIANT_DEFAULTS.full.map((key) => [key, { ...getEffectivePanelConfig(key, 'full') }]),
    );
    const atCap = enforceFreePanelLimit(fullDefaults, false);
    atCap.map = { ...atCap.map!, enabled: false };

    const restored = restoreFreeMapPanelAccess(atCap);

    assert.equal(countFreePanelCapUsage(atCap), FREE_MAX_PANELS);
    assert.equal(restored.map?.enabled, false);
  });

  it('does not force-enable a manually hidden map when the free layout is under cap', () => {
    const underCap = {
      map: { ...getEffectivePanelConfig('map', 'full'), enabled: false },
      'live-news': getEffectivePanelConfig('live-news', 'full'),
    };

    const restored = restoreFreeMapPanelAccess(underCap);

    assert.equal(restored.map?.enabled, false);
  });

  it('marks free-tier custom widgets and restores only gate-disabled panels for Pro', () => {
    const original = {
      'cw-gated': { name: 'Gated widget', enabled: true, priority: 3 },
      'cw-hidden': { name: 'Hidden widget', enabled: false, priority: 3 },
      news: { name: 'News', enabled: true, priority: 1 },
    };

    const clamped = enforceFreePanelLimit(original, false);
    assert.deepEqual(clamped['cw-gated'], {
      name: 'Gated widget',
      enabled: false,
      priority: 3,
      proGated: true,
    });
    assert.deepEqual(clamped['cw-hidden'], original['cw-hidden']);

    const restored = restoreProGatedPanels(clamped);
    assert.deepEqual(restored['cw-gated'], original['cw-gated']);
    assert.deepEqual(restored['cw-hidden'], original['cw-hidden']);
    assert.deepEqual(restored.news, original.news);
    assert.deepEqual(original['cw-gated'], {
      name: 'Gated widget',
      enabled: true,
      priority: 3,
    });
  });

  it('restores COUNT-CAP-disabled panels for Pro, not just custom widgets', () => {
    // The free-tier gate disables panels two ways: cw-* widgets (stamped
    // proGated, restored by the test above) and everything past
    // FREE_MAX_PANELS by the count cap. Only the first is stamped, and
    // restoreProGatedPanels restores only what is stamped — so the count cap
    // is a ONE-WAY DOOR.
    //
    // Concretely: a user over the cap while free (or during any window where
    // the tier read as free) gets `enabled: false` PERSISTED into
    // STORAGE_KEYS.panels for their lowest-priority panels. Going Pro never
    // puts them back. The panel stays listed in Cmd+K and checkable in
    // settings while being absent from the dashboard — a ghost.
    //
    // The sort is (priority asc, key asc), so at a flat priority the
    // alphabetically-last keys go over the cliff first — which is why
    // late-alphabet panels are the ones that vanish.
    const original: Record<string, { name: string; enabled: boolean; priority: number }> = {};
    for (let i = 0; i < FREE_MAX_PANELS + 5; i += 1) {
      const key = `p${String(i).padStart(2, '0')}`;
      original[key] = { name: key, enabled: true, priority: 1 };
    }
    const overCapKeys = Object.keys(original).slice(FREE_MAX_PANELS);
    assert.equal(overCapKeys.length, 5, 'fixture must actually exceed the cap');

    const clamped = enforceFreePanelLimit(original, false);
    for (const key of overCapKeys) {
      assert.equal(clamped[key]?.enabled, false, `${key} should be clamped off on the free tier`);
    }
    assert.equal(
      countFreePanelCapUsage(clamped), FREE_MAX_PANELS,
      'the clamp must leave exactly the cap enabled',
    );

    const restored = restoreProGatedPanels(clamped);
    for (const key of overCapKeys) {
      assert.equal(
        restored[key]?.enabled, true,
        `${key} was disabled by the free-tier cap, not by the user — going Pro must put it back`,
      );
    }

    // The restore must not become a blanket enable-everything: a panel the
    // USER turned off has to stay off.
    const userHidden = enforceFreePanelLimit(
      { ...original, p00: { name: 'p00', enabled: false, priority: 1 } },
      false,
    );
    assert.equal(restoreProGatedPanels(userHidden).p00?.enabled, false,
      'a deliberately hidden panel must stay hidden');
  });

  it('a user toggle takes ownership: a later deliberate hide survives going Pro', () => {
    // The marker means "the GATE owns this disable". If it survives a USER
    // re-enable, a later deliberate hide is indistinguishable from gate damage
    // and the next Pro reconcile resurrects a panel the user chose to hide —
    // then cloud-syncs that resurrection to every device.
    //
    // The over-cap fixture above hides its panel BEFORE the clamp, so the
    // marker is never set on it. This covers the real sequence: clamp, user
    // re-enables, user later hides.
    const original: Record<string, { name: string; enabled: boolean; priority: number }> = {};
    for (let i = 0; i < FREE_MAX_PANELS + 1; i += 1) {
      const key = `q${String(i).padStart(2, '0')}`;
      original[key] = { name: key, enabled: true, priority: 1 };
    }
    const clampedKey = Object.keys(original)[FREE_MAX_PANELS]!;

    const clamped = enforceFreePanelLimit(original, false);
    assert.equal(clamped[clampedKey]?.enabled, false);
    assert.equal(clamped[clampedKey]?.proGated, true, 'the gate owns this disable');

    // 1. User re-enables it themselves (Cmd+K, settings toggle, undo-close).
    userSetPanelEnabled(clamped[clampedKey]!, true);
    assert.equal(clamped[clampedKey]?.proGated, undefined,
      'a user toggle transfers ownership away from the gate — the marker must go');

    // 2. Later, the user deliberately hides it.
    userSetPanelEnabled(clamped[clampedKey]!, false);

    // 3. Going Pro must NOT resurrect it.
    assert.equal(restoreProGatedPanels(clamped)[clampedKey]?.enabled, false,
      'a panel the user hid after re-enabling it must stay hidden');
  });

  it('defers free-tier enforcement until both Clerk and the entitlement snapshot settle', () => {
    // Clerk still pending: always defer — a signed-in Pro user is
    // indistinguishable from an anonymous one.
    assert.equal(shouldDeferFreeTierEnforcement(true, false, false, false), true);
    // Clerk settled on a signed-in user, entitlement snapshot not yet
    // loaded: defer — isEntitled() is deterministically false until the
    // snapshot lands, so a Convex-only Pro subscriber would be clamped.
    assert.equal(shouldDeferFreeTierEnforcement(false, true, false, false), true);
    // Clerk settled, signed-in, entitlement loaded: enforce.
    assert.equal(shouldDeferFreeTierEnforcement(false, true, true, false), false);
    // Clerk settled, anonymous: enforce immediately.
    assert.equal(shouldDeferFreeTierEnforcement(false, false, false, false), false);
    // Grace deadline exceeded: never defer, whatever else is pending —
    // otherwise a snapshot that never arrives suspends the caps forever.
    assert.equal(shouldDeferFreeTierEnforcement(true, true, false, true), false);
  });

  it('does not use the canonical registry directly for entitlement or pro badge metadata', () => {
    const files = [
      'src/components/UnifiedSettings.ts',
      'src/app/search-manager.ts',
      'src/settings-window.ts',
    ];

    for (const file of files) {
      const text = src(file);
      assert.doesNotMatch(
        text,
        /isPanelEntitled\([^\n]*ALL_PANELS\[/,
        `${file} must resolve variant-specific panel config before entitlement checks`,
      );
      assert.doesNotMatch(
        text,
        /\(ALL_PANELS\[[^\]]+\]\s*\?\?[^)]*\)\.premium/,
        `${file} must resolve variant-specific panel config before PRO badge checks`,
      );
    }
  });

  it('standalone settings render uses resolved variant names instead of saved panel names', () => {
    const text = src('src/settings-window.ts');

    assert.match(
      text,
      /const resolvedPanel = ALL_PANELS\[key\] \? getEffectivePanelConfig\(key, SITE_VARIANT\) : panel;/,
      'settings-window render must resolve variant-specific panel config per entry',
    );
    assert.match(
      text,
      /getLocalizedPanelName\(key, resolvedPanel\.name \?\? panel\.name\)/,
      'settings-window render must prefer the resolved variant name before saved panel.name',
    );
  });
});
