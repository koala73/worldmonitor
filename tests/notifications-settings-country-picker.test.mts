/**
 * Tests for the country chip picker (Layer 4 of country-scoping PR).
 *
 * Two test surfaces:
 *  1. Source-grep on src/services/notifications-settings.ts: the picker is
 *     mounted, smart-default reads from the window registry, edit-existing
 *     respects stored countries, EVERY alertRules save path sources its
 *     payload from the centralized getCurrentAlertRuleFormState helper.
 *  2. Behavioural unit tests on the pure helpers
 *     (normalizeIso2, mountCountryChipPicker via a minimal DOM stub,
 *     loadFollowedCountriesSafe via a window-registry stub).
 *
 * No JSDOM dependency: we hand-roll a tiny element stub sufficient to drive
 * the picker's render + click logic. Keeps the test footprint small and
 * matches the project convention (vitest + edge-runtime, tsx --test for
 * tests/*.mts).
 *
 * Run: tsx --test tests/notifications-settings-country-picker.test.mts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeIso2,
  mountCountryChipPicker,
  loadFollowedCountriesSafe,
  COUNTRY_CHIP_PICKER_MAX,
} from '../src/utils/country-chip-picker.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const settingsSrc = readFileSync(
  resolve(__dirname, '..', 'src', 'services', 'notifications-settings.ts'),
  'utf-8',
);
const pickerSrc = readFileSync(
  resolve(__dirname, '..', 'src', 'utils', 'country-chip-picker.ts'),
  'utf-8',
);

// ---------------------------------------------------------------------------
// Source-grep contract — notifications-settings.ts
// ---------------------------------------------------------------------------

describe('notifications-settings.ts — country picker integration', () => {
  it('imports mountCountryChipPicker + loadFollowedCountriesSafe', () => {
    assert.match(
      settingsSrc,
      /from\s+['"]@\/utils\/country-chip-picker['"]/,
      'must import from country-chip-picker',
    );
    assert.match(settingsSrc, /mountCountryChipPicker/, 'must reference mountCountryChipPicker');
    assert.match(settingsSrc, /loadFollowedCountriesSafe/, 'must reference loadFollowedCountriesSafe');
  });

  it('renders a #usNotifCountryPicker mount point', () => {
    assert.match(
      settingsSrc,
      /id=["']usNotifCountryPicker["']/,
      'render must include id="usNotifCountryPicker"',
    );
  });

  it('smart-default ONLY when existingRule === null (NEW rule)', () => {
    assert.match(
      settingsSrc,
      /isNewRule\s*=\s*existingRule\s*===\s*null/,
      'must derive isNewRule from existingRule === null',
    );
    // Smart-default load is gated by the isNewRule branch, not unconditional.
    assert.match(
      settingsSrc,
      /if\s*\(\s*isNewRule\s*\)\s*{[\s\S]*?loadFollowedCountriesSafe/,
      'loadFollowedCountriesSafe must be inside the isNewRule branch',
    );
  });

  it('Country scope section header is rendered', () => {
    assert.match(
      settingsSrc,
      /Country scope/,
      'render must include the "Country scope" section label',
    );
  });

  it('hint copy mentions "Leave empty" so users know the empty state means all-countries', () => {
    assert.match(
      settingsSrc,
      /Leave empty to receive alerts from all countries/,
      'must include the "leave empty" hint',
    );
  });

  it('preselectCountry parameter is declared on the host interface (PR B U8 R9 receiver)', () => {
    assert.match(
      settingsSrc,
      /preselectCountry\?:\s*string/,
      'NotificationsSettingsHost must expose preselectCountry?: string',
    );
  });

  it('preselectCountry is normalized via /^[A-Z]{2}$/ regex (defensive validation at the entry point)', () => {
    assert.match(
      settingsSrc,
      /normalizePreselectCountry/,
      'must define a normalizePreselectCountry helper',
    );
    assert.match(
      settingsSrc,
      /\/\^\[A-Z\]\{2\}\$\//,
      'normalizer must validate against /^[A-Z]{2}$/',
    );
  });

  it('preselectCountry takes precedence over loadFollowedCountriesSafe on NEW rules (R9 pre-fill wins over watchlist smart-default)', () => {
    // Verify the if-branch that prioritizes preselectCountry exists inside
    // the NEW-rule branch.
    assert.match(
      settingsSrc,
      /if\s*\(\s*isNewRule\s*\)\s*{[\s\S]*?if\s*\(\s*preselectCountry\s*\)\s*{[\s\S]*?initial\s*=\s*\[\s*preselectCountry\s*\][\s\S]*?else[\s\S]*?loadFollowedCountriesSafe/,
      'NEW-rule branch must check preselectCountry before falling back to loadFollowedCountriesSafe',
    );
  });

  it('preselectCountry does NOT override existing rule countries (edit-existing respects stored value)', () => {
    // The preselect-precedence check is gated by `if (isNewRule)`, so
    // existing-rule path must NOT reference preselectCountry.
    // Source-grep: between the `existingRule !== null` branch start and the
    // isNewRule check, no preselectCountry mentions should exist.
    const existingRulePathMatch = settingsSrc.match(
      /existingCountries[\s\S]*?const\s+isNewRule\s*=\s*existingRule\s*===\s*null/,
    );
    assert.ok(existingRulePathMatch, 'existingCountries → isNewRule region must exist');
    // Just verify the existing-rule path doesn't snake `preselectCountry` into
    // its initial assignment — the precedence is one-way (NEW rule only).
    const existingRuleSlice = existingRulePathMatch[0];
    assert.ok(
      !/preselectCountry/.test(existingRuleSlice),
      'existing-rule path must not reference preselectCountry — preselect ONLY applies on NEW rules',
    );
  });
});

// ---------------------------------------------------------------------------
// Source-grep contract — centralized save-path helper (countries thread-through)
// ---------------------------------------------------------------------------

describe('notifications-settings.ts — centralized save state (countries thread-through)', () => {
  it('declares getCurrentAlertRuleFormState helper', () => {
    assert.match(
      settingsSrc,
      /function\s+getCurrentAlertRuleFormState\s*\(/,
      'must declare getCurrentAlertRuleFormState helper',
    );
  });

  it('helper sources `countries` from countryPicker.getValue() (with undefined fallback)', () => {
    assert.match(
      settingsSrc,
      /countries:\s*countryPicker\s*\?\s*countryPicker\.getValue\(\)\s*:\s*undefined/,
      'getCurrentAlertRuleFormState must read countries from picker',
    );
  });

  it('picker-absent saves intentionally pass countries: undefined for preserve-on-omit', () => {
    assert.match(
      settingsSrc,
      /const\s+alertRuleCountries\s*=\s*countryPicker\s*\?\s*countryPicker\.getValue\(\)\s*:\s*undefined/,
      'helper must name the picker-absent undefined fallback so preserve-on-omit is deliberate',
    );
    assert.match(
      settingsSrc,
      /countries:\s*alertRuleCountries/,
      'helper must pass the named fallback through as countries',
    );
  });

  it('saveCurrentAlertRule uses getCurrentAlertRuleFormState (debounced picker save)', () => {
    assert.match(
      settingsSrc,
      /function\s+saveCurrentAlertRule\s*\(\)[\s\S]*?const\s+state\s*=\s*getCurrentAlertRuleFormState\(\)[\s\S]*?saveAlertRules\(/,
      'saveCurrentAlertRule must source payload from getCurrentAlertRuleFormState',
    );
  });

  it('saveRuleWithNewChannel uses getCurrentAlertRuleFormState (channel-connect save path)', () => {
    // This is the call site that R2 found — connecting a channel raced the
    // debounced picker save and dropped countries.
    assert.match(
      settingsSrc,
      /function\s+saveRuleWithNewChannel[\s\S]*?const\s+state\s*=\s*getCurrentAlertRuleFormState\(\)[\s\S]*?saveAlertRules\(/,
      'saveRuleWithNewChannel must source payload from getCurrentAlertRuleFormState',
    );
  });

  it('AI digest toggle save path uses getCurrentAlertRuleFormState', () => {
    // The usAiDigestEnabled change handler used to hand-roll its own payload
    // and silently dropped countries. Centralized via the helper.
    assert.match(
      settingsSrc,
      /target\.id\s*===\s*'usAiDigestEnabled'[\s\S]*?const\s+state\s*=\s*getCurrentAlertRuleFormState\(\)[\s\S]*?saveAlertRules\(/,
      'AI digest toggle save must source payload from getCurrentAlertRuleFormState',
    );
  });

  it('enable + sensitivity save path uses getCurrentAlertRuleFormState', () => {
    // The combined usNotifEnabled / usNotifSensitivity change handler used
    // to hand-roll its own payload and silently dropped countries.
    assert.match(
      settingsSrc,
      /target\.id\s*===\s*'usNotifEnabled'\s*\|\|\s*target\.id\s*===\s*'usNotifSensitivity'[\s\S]*?const\s+state\s*=\s*getCurrentAlertRuleFormState\(\)[\s\S]*?saveAlertRules\(/,
      'enable/sensitivity save must source payload from getCurrentAlertRuleFormState',
    );
  });

  it('quiet-hours, digest, and delivery-mode saves thread picker countries through insert-capable APIs', () => {
    assert.match(
      settingsSrc,
      /setQuietHours\(\{[\s\S]*?countries:\s*countryPicker\s*\?\s*countryPicker\.getValue\(\)\s*:\s*undefined/,
      'setQuietHours save must include current picker countries',
    );
    assert.match(
      settingsSrc,
      /setDigestSettings\(\{[\s\S]*?countries:\s*countryPicker\s*\?\s*countryPicker\.getValue\(\)\s*:\s*undefined/,
      'setDigestSettings save must include current picker countries',
    );
    assert.match(
      settingsSrc,
      /setNotificationConfig\(\{[\s\S]*?\.\.\.state[\s\S]*?digestMode:/,
      'setNotificationConfig save must spread current form state, including countries',
    );
  });

  it('NO save path hand-rolls its own AlertRule payload (every saveAlertRules call must spread `state`)', () => {
    // Catch future drift: any direct `saveAlertRules({` block that lists
    // `enabled, eventTypes, sensitivity, channels, aiDigestEnabled` without
    // `...state` is a regression of the centralization fix.
    //
    // Match every saveAlertRules invocation; each must contain `...state`.
    const calls = settingsSrc.match(/saveAlertRules\(\{[\s\S]*?\}\)/g) ?? [];
    assert.ok(calls.length >= 4, `expected ≥4 saveAlertRules call sites, found ${calls.length}`);
    for (const call of calls) {
      assert.match(
        call,
        /\.\.\.state/,
        `saveAlertRules call must spread getCurrentAlertRuleFormState() result via ...state — found:\n${call}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Source-grep contract — country-chip-picker.ts (window-registry pattern)
// ---------------------------------------------------------------------------

describe('country-chip-picker.ts — window-registry pattern (no dynamic import)', () => {
  it('reads from window.__wmFollowedCountries instead of dynamic-importing PR A', () => {
    // The window-registry pattern decouples PR A and PR #3632 shipping
    // cadence: PR A self-registers, PR #3632 reads-if-present. No Vite
    // alias coupling, no @vite-ignore tricks.
    assert.match(
      pickerSrc,
      /window\.__wmFollowedCountries|__wmFollowedCountries/,
      'loadFollowedCountriesSafe must read from window.__wmFollowedCountries',
    );
  });

  it('does NOT use dynamic import for followed-countries (legacy approach removed)', () => {
    // The legacy approach used `import(/* @vite-ignore */ path)` which
    // leaves the unresolvable `@/services/followed-countries` alias in the
    // browser bundle. We replaced it with the window-registry pattern.
    assert.doesNotMatch(
      pickerSrc,
      /import\s*\(\s*\/\*\s*@vite-ignore\s*\*\/\s*path\s*\)/,
      'must not use legacy dynamic-import-with-@vite-ignore approach',
    );
    assert.doesNotMatch(
      pickerSrc,
      /const\s+path\s*=\s*['"]@\/services\/followed-countries['"]/,
      'must not stash followed-countries alias in a string variable',
    );
  });

  it('loadFollowedCountriesSafe is synchronous (no async / no Promise return)', () => {
    // The function signature was changed from `async function` /
    // `Promise<string[]>` to a synchronous `string[]` return so callers
    // don't need to await. This avoids accidentally serializing first paint
    // on a cache hit.
    assert.match(
      pickerSrc,
      /export\s+function\s+loadFollowedCountriesSafe\s*\(\s*\)\s*:\s*string\[\]/,
      'loadFollowedCountriesSafe must be synchronous and return string[]',
    );
    assert.doesNotMatch(
      pickerSrc,
      /export\s+async\s+function\s+loadFollowedCountriesSafe/,
      'must not be async',
    );
  });

  it('caller does NOT await the synchronous helper', () => {
    // notifications-settings.ts must call it synchronously. If the call site
    // still awaits, it's a leftover from the dynamic-import era.
    assert.doesNotMatch(
      settingsSrc,
      /await\s+loadFollowedCountriesSafe/,
      'caller must not await the synchronous helper',
    );
  });
});

// ---------------------------------------------------------------------------
// Behavioural — normalizeIso2
// ---------------------------------------------------------------------------

describe('normalizeIso2', () => {
  it('accepts uppercase 2-letter codes', () => {
    assert.equal(normalizeIso2('US'), 'US');
    assert.equal(normalizeIso2('GB'), 'GB');
  });

  it('uppercases lowercase input', () => {
    assert.equal(normalizeIso2('us'), 'US');
    assert.equal(normalizeIso2('gb'), 'GB');
  });

  it('trims whitespace', () => {
    assert.equal(normalizeIso2('  IR  '), 'IR');
  });

  it('rejects non-2-letter shapes', () => {
    assert.equal(normalizeIso2('USA'), null);
    assert.equal(normalizeIso2('U'), null);
    assert.equal(normalizeIso2(''), null);
    assert.equal(normalizeIso2('US123'), null);
    assert.equal(normalizeIso2('United States'), null);
    assert.equal(normalizeIso2('1A'), null);
  });
});

// ---------------------------------------------------------------------------
// Behavioural — loadFollowedCountriesSafe (window registry)
// ---------------------------------------------------------------------------

describe('loadFollowedCountriesSafe — window-registry stub', () => {
  // The picker module reads `window.__wmFollowedCountries` at call time;
  // we mutate `globalThis.window` per-test to drive the registry.
  const originalWindow = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    (globalThis as { window?: unknown }).window = {};
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });

  it('returns [] when window.__wmFollowedCountries is absent (PR A not loaded)', () => {
    // Default degraded behavior — picker shows nothing pre-checked.
    assert.deepEqual(loadFollowedCountriesSafe(), []);
  });

  it('returns the registry value when PR A self-registered', () => {
    (globalThis as { window: { __wmFollowedCountries?: unknown } }).window.__wmFollowedCountries = {
      getFollowed: () => ['US', 'GB'],
    };
    assert.deepEqual(loadFollowedCountriesSafe(), ['US', 'GB']);
  });

  it('normalizes registry values (lowercase → uppercase, trim, drop bad shapes)', () => {
    (globalThis as { window: { __wmFollowedCountries?: unknown } }).window.__wmFollowedCountries = {
      getFollowed: () => ['us', '  GB  ', 'United States', 'Z'],
    };
    assert.deepEqual(loadFollowedCountriesSafe(), ['US', 'GB']);
  });

  it('returns [] when getFollowed throws', () => {
    (globalThis as { window: { __wmFollowedCountries?: unknown } }).window.__wmFollowedCountries = {
      getFollowed: () => { throw new Error('boom'); },
    };
    assert.deepEqual(loadFollowedCountriesSafe(), []);
  });

  it('returns [] when getFollowed returns a non-array', () => {
    (globalThis as { window: { __wmFollowedCountries?: unknown } }).window.__wmFollowedCountries = {
      getFollowed: () => 'not-an-array',
    };
    assert.deepEqual(loadFollowedCountriesSafe(), []);
  });

  it('returns [] when getFollowed is missing', () => {
    (globalThis as { window: { __wmFollowedCountries?: unknown } }).window.__wmFollowedCountries = {};
    assert.deepEqual(loadFollowedCountriesSafe(), []);
  });
});

// ---------------------------------------------------------------------------
// Behavioural — mountCountryChipPicker via minimal DOM stub
// ---------------------------------------------------------------------------

// Minimal DOM stub. Only the methods/properties the picker touches:
//  - innerHTML (read after render to inspect output)
//  - querySelector / querySelectorAll (against the rendered HTML)
//  - addEventListener / removeEventListener
//  - dispatchEvent (so we can trigger click handlers)
//
// This is much smaller than pulling in JSDOM/happy-dom for one test file.
// Trade-off: we re-render text, then re-parse the HTML each time we want to
// inspect — fine for a handful of assertions.

interface FakeElement {
  innerHTML: string;
  __listeners: Map<string, Set<(e: any) => void>>;
  querySelector: <T = FakeElement>(selector: string) => T | null;
  querySelectorAll: <T = FakeElement>(selector: string) => T[];
  addEventListener: (type: string, handler: (e: any) => void) => void;
  removeEventListener: (type: string, handler: (e: any) => void) => void;
  dispatchEvent: (e: any) => void;
}

function makeFakeElement(): FakeElement {
  const el: FakeElement = {
    innerHTML: '',
    __listeners: new Map(),
    addEventListener(type: string, handler: (e: any) => void) {
      let s = this.__listeners.get(type);
      if (!s) {
        s = new Set();
        this.__listeners.set(type, s);
      }
      s.add(handler);
    },
    removeEventListener(type: string, handler: (e: any) => void) {
      this.__listeners.get(type)?.delete(handler);
    },
    dispatchEvent(e: any) {
      const handlers = this.__listeners.get(e.type) ?? new Set();
      for (const h of handlers) h(e);
    },
    querySelector<T = FakeElement>(_selector: string): T | null {
      // Picker only needs querySelector for the input + add button after a
      // re-render. Returning null is fine for assertions that don't depend on
      // those elements.
      return null;
    },
    querySelectorAll<T = FakeElement>(_selector: string): T[] {
      return [];
    },
  };
  return el;
}

describe('mountCountryChipPicker', () => {
  it('renders chips for the initial selection', () => {
    const root = makeFakeElement() as unknown as HTMLElement;
    const picker = mountCountryChipPicker(root, { initial: ['US', 'GB'] });
    assert.match(root.innerHTML, /data-code="US"/, 'must render US chip');
    assert.match(root.innerHTML, /data-code="GB"/, 'must render GB chip');
    assert.match(
      root.innerHTML,
      /data-code="US"[^>]*aria-pressed="true"/,
      'US chip must be pressed',
    );
    assert.match(
      root.innerHTML,
      /data-code="GB"[^>]*aria-pressed="true"/,
      'GB chip must be pressed',
    );
    assert.deepEqual(picker.getValue(), ['US', 'GB']);
    picker.destroy();
  });

  it('initial=[] renders all chips unpressed (= all countries)', () => {
    const root = makeFakeElement() as unknown as HTMLElement;
    const picker = mountCountryChipPicker(root, { initial: [] });
    assert.deepEqual(picker.getValue(), []);
    // No aria-pressed="true" should appear when nothing is selected.
    assert.doesNotMatch(
      root.innerHTML,
      /aria-pressed="true"/,
      'no chips should be pressed when initial=[]',
    );
    picker.destroy();
  });

  it('normalizes initial values (lowercase, whitespace, dedupe, drop bad shapes)', () => {
    const root = makeFakeElement() as unknown as HTMLElement;
    const picker = mountCountryChipPicker(root, {
      initial: ['us', '  GB  ', 'US', 'United States', 'Z'],
    });
    assert.deepEqual(picker.getValue(), ['US', 'GB']);
    picker.destroy();
  });

  it('caps initial and setValue selections at 50 countries', () => {
    const codes: string[] = [];
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    outer: for (let i = 0; i < letters.length; i++) {
      for (let j = 0; j < letters.length; j++) {
        codes.push(letters[i] + letters[j]);
        if (codes.length >= COUNTRY_CHIP_PICKER_MAX + 10) break outer;
      }
    }

    const root = makeFakeElement() as unknown as HTMLElement;
    const picker = mountCountryChipPicker(root, { initial: codes });
    assert.equal(picker.getValue().length, COUNTRY_CHIP_PICKER_MAX);

    picker.setValue(codes.reverse());
    assert.equal(picker.getValue().length, COUNTRY_CHIP_PICKER_MAX);
    picker.destroy();
  });

  it('setValue replaces the selection and emits onChange', () => {
    const root = makeFakeElement() as unknown as HTMLElement;
    const events: string[][] = [];
    const picker = mountCountryChipPicker(root, {
      initial: ['US'],
      onChange: (codes) => { events.push(codes); },
    });
    picker.setValue(['fr', 'DE']);
    assert.deepEqual(picker.getValue(), ['FR', 'DE']);
    assert.deepEqual(events.at(-1), ['FR', 'DE']);
    picker.destroy();
  });

  it('chip toggle: clicking a pressed chip removes it', () => {
    const root = makeFakeElement() as unknown as HTMLElement;
    let lastEmit: string[] = [];
    const picker = mountCountryChipPicker(root, {
      initial: ['US', 'GB'],
      onChange: (codes) => { lastEmit = codes; },
    });
    // Simulate a click on the US chip. The picker delegates via root's
    // 'click' event; our fake supports dispatchEvent. We emulate the
    // target.closest('.us-notif-country-chip') by handing a stub target.
    const fakeChip = {
      dataset: { code: 'US' },
      closest(sel: string) {
        return sel === '.us-notif-country-chip' ? this : null;
      },
      matches(_sel: string) { return false; },
    };
    root.dispatchEvent({ type: 'click', target: fakeChip });
    assert.deepEqual(picker.getValue(), ['GB']);
    assert.deepEqual(lastEmit, ['GB']);
    picker.destroy();
  });

  it('chip toggle: clicking an unpressed chip adds it', () => {
    const root = makeFakeElement() as unknown as HTMLElement;
    let lastEmit: string[] = [];
    const picker = mountCountryChipPicker(root, {
      initial: [],
      onChange: (codes) => { lastEmit = codes; },
    });
    const fakeChip = {
      dataset: { code: 'FR' },
      closest(sel: string) {
        return sel === '.us-notif-country-chip' ? this : null;
      },
      matches(_sel: string) { return false; },
    };
    root.dispatchEvent({ type: 'click', target: fakeChip });
    assert.deepEqual(picker.getValue(), ['FR']);
    assert.deepEqual(lastEmit, ['FR']);
    picker.destroy();
  });

  it('destroy clears innerHTML and detaches listeners', () => {
    const root = makeFakeElement() as unknown as HTMLElement;
    let emitted = false;
    const picker = mountCountryChipPicker(root, {
      initial: ['US'],
      onChange: () => { emitted = true; },
    });
    picker.destroy();
    assert.equal(root.innerHTML, '', 'innerHTML cleared on destroy');
    // Sanity: post-destroy click is a no-op (listener removed).
    picker.destroy(); // idempotent
    const fakeChip = {
      dataset: { code: 'GB' },
      closest(sel: string) {
        return sel === '.us-notif-country-chip' ? this : null;
      },
      matches(_sel: string) { return false; },
    };
    root.dispatchEvent({ type: 'click', target: fakeChip });
    assert.equal(emitted, false);
  });
});
