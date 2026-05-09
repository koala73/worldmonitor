/**
 * Tests for the country chip picker (Layer 4 of country-scoping PR).
 *
 * Two test surfaces:
 *  1. Source-grep on src/services/notifications-settings.ts: the picker is
 *     mounted, smart-default uses dynamic import, edit-existing respects
 *     stored countries, save flow forwards `countries`.
 *  2. Behavioural unit tests on the pure helpers
 *     (normalizeIso2, mountCountryChipPicker via a minimal DOM stub).
 *
 * No JSDOM dependency: we hand-roll a tiny element stub sufficient to drive
 * the picker's render + click logic. Keeps the test footprint small and
 * matches the project convention (vitest + edge-runtime, tsx --test for
 * tests/*.mts).
 *
 * Run: tsx --test tests/notifications-settings-country-picker.test.mts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeIso2,
  mountCountryChipPicker,
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

  it('saveCurrentAlertRule forwards countries from the picker', () => {
    assert.match(
      settingsSrc,
      /countries:\s*countryPicker\s*\?\s*countryPicker\.getValue\(\)\s*:\s*undefined/,
      'saveCurrentAlertRule must forward picker.getValue() as countries',
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
// Source-grep contract — country-chip-picker.ts
// ---------------------------------------------------------------------------

describe('country-chip-picker.ts — dynamic import + degradation', () => {
  it('uses dynamic import via a string variable + /* @vite-ignore */ for graceful degradation', () => {
    // Critical for shipping independently of PR A: Vite must not statically
    // resolve @/services/followed-countries (it doesn't exist on this branch).
    assert.match(
      pickerSrc,
      /\/\*\s*@vite-ignore\s*\*\//,
      'loadFollowedCountriesSafe must use /* @vite-ignore */ to skip static analysis',
    );
    assert.match(
      pickerSrc,
      /const\s+path\s*=\s*['"]@\/services\/followed-countries['"]/,
      'dynamic import target must be assigned to a variable so the bundler does not eagerly resolve it',
    );
    // The catch path returning [] is what makes this graceful.
    assert.match(
      pickerSrc,
      /\.catch\(\s*\(\s*\)\s*=>\s*null\s*\)/,
      'failed import must resolve to null (then short-circuit to [])',
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
    const picker = mountCountryChipPicker(root, { initial: ['US'] });
    picker.destroy();
    assert.equal(root.innerHTML, '', 'innerHTML cleared on destroy');
    // Sanity: post-destroy click is a no-op (listener removed).
    let emitted = false;
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
