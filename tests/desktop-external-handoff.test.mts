/**
 * #5911 — billing/upgrade navigation must LEAVE the desktop WebView.
 *
 * Before this, `openBillingPortal()` had no desktop branch: it ran
 * `window.open` / `window.location.assign`, which inside Tauri navigates the
 * app's own WebView to Dodo's portal. The user loses the entire app to a
 * third-party page with no tab strip and no back button.
 *
 * The established convention (`components/Panel.ts`,
 * `components/ResilienceWidget.ts`, the anchor interceptor in
 * `app/event-handlers.ts`) is `openExternalUrl(url)`, which hands the URL to
 * the OS default browser in desktop builds and preserves web fallback behavior.
 *
 * These drive the REAL `isDesktopRuntime()` detector — the window shape below
 * is what a shipped Tauri build actually presents — plus the REAL
 * `tauri-bridge`, `external-navigation` and `billing` modules. Only Clerk and
 * the Convex client are doubled, because a portal session is a server
 * round-trip. The decisive assertion in every desktop case is negative: the
 * WebView never navigated.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

interface TauriInvocation {
  command: string;
  payload?: Record<string, unknown>;
}

interface WindowProbe {
  invocations: TauriInvocation[];
  opened: Array<[string, string | undefined, string | undefined]>;
  assigned: string[];
  /** Handles returned by window.open that the code under test then closed. */
  closedTabs: number;
  /** Tabs the browser opened but returned no handle for (`noopener`). */
  openedWithoutHandle: number;
  /** Every handle the fake handed back, so opener-severing is assertable. */
  handedOutTabs: Array<{ opener: unknown }>;
  /** Simulates the Rust side rejecting (bad scheme, opener failure). */
  invokeRejects: boolean;
  /** Simulates a native call that never settles at all. */
  invokeHangs: boolean;
  /** Simulates a popup blocker: window.open returns null. */
  popupBlocked: boolean;
}

let probe: WindowProbe;

function makeTab(): {
  closed: boolean;
  location: { href: string };
  close: () => void;
  opener: unknown;
} {
  const tab = {
    closed: false,
    location: { href: '' },
    // Starts non-null so `opener === null` proves the code severed it, rather
    // than passing because the fake never had one. This is the property that
    // replaced `noopener` in the feature string.
    opener: {} as unknown,
    close(): void {
      tab.closed = true;
      probe.closedTabs += 1;
    },
  };
  probe.handedOutTabs.push(tab);
  return tab;
}

/**
 * `desktop` mirrors a shipped Tauri window: bridge globals present, a
 * `tauri://localhost` origin and `Tauri` in the UA. `web` deliberately trips
 * none of `detectDesktopRuntime`'s signals (no globals, https on the real
 * host, plain UA) so the web path is asserted against the same real detector.
 */
function installWindow(kind: 'desktop' | 'web'): void {
  probe = {
    invocations: [],
    opened: [],
    assigned: [],
    closedTabs: 0,
    openedWithoutHandle: 0,
    handedOutTabs: [],
    invokeRejects: false,
    invokeHangs: false,
    popupBlocked: false,
  };

  const desktop = kind === 'desktop';
  const location = {
    protocol: desktop ? 'tauri:' : 'https:',
    host: desktop ? 'tauri.localhost' : 'worldmonitor.app',
    hostname: desktop ? 'tauri.localhost' : 'worldmonitor.app',
    origin: desktop ? 'tauri://localhost' : 'https://worldmonitor.app',
    href: desktop ? 'tauri://localhost/index.html' : 'https://worldmonitor.app/dashboard',
    assign: (url: string) => {
      probe.assigned.push(url);
    },
  };
  const win: Record<string, unknown> = {
    navigator: { userAgent: desktop ? 'Mozilla/5.0 Tauri/2.11.5' : 'Mozilla/5.0 Chrome/140' },
    location,
    // Spec-accurate on the one detail that matters here: `noopener` (and
    // `noreferrer`, which implies it) makes `window.open` return null WHILE
    // STILL OPENING THE TAB. A fake that hands back a handle regardless of
    // the feature string reports every success as a blocked popup, which is
    // exactly how the always-assign bug reached main unnoticed. Verified in
    // Chrome: window.open(url,'_blank','noopener,noreferrer') === null with
    // the tab present in the tab list.
    open: (url: string, target?: string, features?: string) => {
      probe.opened.push([url, target, features]);
      if (probe.popupBlocked) return null;
      // The tab opens either way; only the HANDLE is withheld. Recording it
      // in `handedOutTabs` would be wrong — nothing can sever an opener it
      // was never given, which is the whole trap.
      if (/\bnoopener\b|\bnoreferrer\b/.test(features ?? '')) {
        probe.openedWithoutHandle += 1;
        return null;
      }
      return makeTab();
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  if (desktop) {
    win.__TAURI_INTERNALS__ = {
      invoke: (command: string, payload?: Record<string, unknown>) => {
        probe.invocations.push({ command, payload });
        if (probe.invokeHangs) return new Promise(() => {});
        if (probe.invokeRejects) return Promise.reject(new Error('open_url refused the URL'));
        return Promise.resolve();
      },
    };
  }

  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  // `config/variant.ts` reads the bare `location` global, not `window.location`.
  Object.defineProperty(globalThis, 'location', { configurable: true, value: location });
}

// Every module under test reads `window` lazily (per call), but `billing.ts`
// still reaches module-scope browser reads through its own graph — so a
// window must exist before the imports below.
installWindow('web');

const { isOpenableExternalUrl, openExternalUrl, prereserveExternalTab } = await import(
  '../src/services/external-navigation.ts'
);
const { openBillingPortal, prereserveBillingPortalTab } = await import(
  '../src/services/billing.ts'
);
const { __setClerkInstanceForTests } = await import('../src/services/clerk.ts');
const { __setConvexClientForTests } = await import('../src/services/convex-client.ts');

const PORTAL_URL = 'https://checkout.dodopayments.com/portal/session-abc';

class FakePortalClient {
  authConfigs: Array<{ onChange: (ok: boolean) => void }> = [];
  setAuth(_fetchToken: unknown, onChange: (ok: boolean) => void): void {
    this.authConfigs.push({ onChange });
  }
  onUpdate(): (() => void) & { unsubscribe: () => void } {
    const unsubscribe = () => {};
    return Object.assign(unsubscribe, { unsubscribe });
  }
  async query(): Promise<unknown> {
    return null;
  }
  async mutation(): Promise<unknown> {
    return null;
  }
  async action(): Promise<unknown> {
    return { portal_url: PORTAL_URL };
  }
}

/** Signed-in user whose Convex socket has already confirmed the identity. */
function installSignedInPortalUser(): void {
  __setClerkInstanceForTests({
    session: { getToken: async () => 'token-a' },
    user: { id: 'A' },
  } as never);
  const fake = new FakePortalClient();
  __setConvexClientForTests(fake as never);
  fake.authConfigs[0]?.onChange(true);
}

afterEach(() => {
  __setClerkInstanceForTests(null);
  __setConvexClientForTests(null);
});

describe('openExternalUrl — desktop', () => {
  it('hands the URL to the OS browser and never navigates the WebView', async () => {
    installWindow('desktop');

    assert.equal(await openExternalUrl('https://worldmonitor.app/pro'), 'native');

    assert.deepEqual(probe.invocations, [
      { command: 'open_url', payload: { url: 'https://worldmonitor.app/pro' } },
    ]);
    // The whole point: neither of the two ways the WebView could be replaced.
    assert.deepEqual(probe.assigned, []);
    assert.deepEqual(probe.opened, []);
  });

  it('closes a tab a caller reserved before it knew the runtime', async () => {
    installWindow('desktop');
    const stray = makeTab();

    assert.equal(await openExternalUrl('https://worldmonitor.app/pro', stray), 'native');

    assert.equal(stray.closed, true, 'a blank WebView window must not be left behind the browser');
    assert.equal(stray.location.href, '', 'the reserved tab must never be navigated on desktop');
    assert.equal(probe.invocations.length, 1);
  });

  // Bounded so a regression that drops the timeout fails fast here instead of
  // hanging the whole suite until the CI job's own limit.
  it('gives up on a native call that never settles instead of hanging its caller', { timeout: 10_000 }, async () => {
    // Without the bound, `startCheckout` awaits forever and its
    // `_checkoutInFlight` guard — released only in a `finally` — latches, so
    // every later upgrade click silently no-ops until the app restarts.
    installWindow('desktop');
    probe.invokeHangs = true;
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const pending = openExternalUrl('https://worldmonitor.app/pro');
      mock.timers.tick(5_000);
      assert.equal(await pending, 'failed', 'the timeout must resolve the caller, not strand it');
    } finally {
      mock.timers.reset();
    }
    assert.equal(probe.invocations.length, 1);
    // No window.open fallback on TIMEOUT specifically: the IPC call is not
    // cancellable, so a slow-but-alive open_url could still complete and the
    // user would get the page twice — once in a WebView, once in the OS
    // browser. For a payment page a clean failure beats a double open.
    assert.deepEqual(probe.opened, [], 'a timed-out open must not also open a WebView window');
  });

  it('reports failure when the native opener refuses AND the popup is blocked', async () => {
    installWindow('desktop');
    probe.invokeRejects = true;
    probe.popupBlocked = true;

    assert.equal(await openExternalUrl('https://worldmonitor.app/pro'), 'failed');

    assert.equal(probe.invocations.length, 1, 'the native path must be tried first');
    assert.deepEqual(probe.assigned, [], 'and the WebView must still not be replaced');
  });

  it('refuses a scheme the native allowlist would reject, without re-opening it', async () => {
    installWindow('desktop');

    assert.equal(await openExternalUrl('file:///etc/passwd'), 'failed');

    assert.deepEqual(probe.invocations, [], 'never hand a refused scheme to the OS opener');
    assert.deepEqual(probe.opened, [], 'and never re-open it in the fallback either');
  });

  it('falls back to window.open when the native opener refuses', async () => {
    installWindow('desktop');
    probe.invokeRejects = true;

    assert.equal(await openExternalUrl('https://worldmonitor.app/pro'), 'popup');

    assert.equal(probe.invocations.length, 1, 'the native path must be tried first');
    assert.deepEqual(probe.opened, [
      ['https://worldmonitor.app/pro', '_blank', undefined],
    ]);
    assert.deepEqual(probe.assigned, [], 'the fallback must still not replace the app');
  });
});

describe('openExternalUrl — web', () => {
  it('navigates a reserved tab in place so the popup blocker stays satisfied', async () => {
    installWindow('web');
    const reserved = makeTab();

    await openExternalUrl(PORTAL_URL, reserved);

    assert.equal(reserved.location.href, PORTAL_URL);
    assert.deepEqual(probe.opened, [], 'a second window.open would be the blocked one');
    assert.deepEqual(probe.invocations, []);
  });

  it('opens a fresh tab when nothing was reserved', async () => {
    installWindow('web');

    await openExternalUrl(PORTAL_URL);

    assert.deepEqual(probe.opened, [[PORTAL_URL, '_blank', undefined]]);
    assert.deepEqual(probe.assigned, []);
  });

  it('falls back to same-tab navigation when the popup is blocked', async () => {
    installWindow('web');
    probe.popupBlocked = true;

    assert.equal(await openExternalUrl(PORTAL_URL), 'same-tab');

    assert.deepEqual(probe.assigned, [PORTAL_URL], 'a blocked upgrade click must not look dead');
  });

  // The regression this suite could not see while its `window.open` fake
  // ignored the feature string: with `noopener` the handle is null even
  // though the tab opened, so the "blocked" fallback fired on every
  // successful web click and the dashboard navigated away underneath it.
  it('opens exactly once — a successful tab must not also navigate the app away', async () => {
    installWindow('web');

    assert.equal(await openExternalUrl(PORTAL_URL), 'popup');

    assert.deepEqual(probe.opened, [[PORTAL_URL, '_blank', undefined]]);
    assert.deepEqual(
      probe.assigned,
      [],
      'the current tab must survive: one click may not both open a tab and replace the page',
    );
    assert.equal(probe.openedWithoutHandle, 0, 'no open may discard its own handle');
  });

  it('severs opener on every tab it hands out, since it no longer passes noopener', async () => {
    installWindow('web');

    await openExternalUrl(PORTAL_URL);

    assert.equal(probe.handedOutTabs.length, 1);
    assert.equal(
      probe.handedOutTabs[0]?.opener,
      null,
      'noopener was dropped to keep the handle — the opener link must be cut manually instead',
    );
  });

  it('refuses to replace a page holding unsaved input when the popup is blocked', async () => {
    installWindow('web');
    probe.popupBlocked = true;

    const outcome = await openExternalUrl(PORTAL_URL, null, { sameTabFallback: false });

    assert.equal(outcome, 'failed');
    assert.deepEqual(
      probe.assigned,
      [],
      'a settings panel with staged secrets must not be navigated out from under the user',
    );
  });
});

/**
 * Exported so `app/event-handlers.ts`'s capture-phase anchor interceptor can
 * gate on the SAME predicate instead of a looser `/^https?:$/`. Those two
 * disagreeing is what made every plain-http link a dead click: the handler
 * cancelled the navigation, then the router refused the URL.
 */
describe('isOpenableExternalUrl — the gate both the router and the interceptor use', () => {
  it('mirrors the native allowlist exactly (src-tauri/src/main.rs open_url)', () => {
    for (const ok of [
      'https://worldmonitor.app/pro',
      'https://example.org/a?b=c#d',
      'http://localhost:5173/x',
      'http://127.0.0.1:46123/health',
    ]) {
      assert.equal(isOpenableExternalUrl(ok), true, `expected openable: ${ok}`);
    }
    for (const no of [
      'http://www.cac.gov.cn/', //        plain http, non-localhost — refused natively
      'http://example.org/story',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<h1>x',
      'not a url',
    ]) {
      assert.equal(isOpenableExternalUrl(no), false, `expected refused: ${no}`);
    }
  });

  it('does not treat a localhost-suffixed host as localhost', () => {
    assert.equal(isOpenableExternalUrl('http://localhost.evil.com/'), false);
    assert.equal(isOpenableExternalUrl('http://127.0.0.1.evil.com/'), false);
  });
});

describe('prereserveExternalTab', () => {
  it('reserves nothing on desktop — there is no popup to protect', () => {
    installWindow('desktop');

    assert.equal(prereserveExternalTab(), null);
    assert.deepEqual(probe.opened, [], 'a blank window.open would strand an empty WebView');
  });

  it('still reserves a blank tab on web', () => {
    installWindow('web');

    assert.notEqual(prereserveExternalTab(), null);
    assert.deepEqual(probe.opened, [['', '_blank', undefined]]);
  });

  it('is what prereserveBillingPortalTab delegates to, so billing inherits both', () => {
    installWindow('desktop');
    assert.equal(prereserveBillingPortalTab(), null);

    installWindow('web');
    assert.notEqual(prereserveBillingPortalTab(), null);
  });
});

describe('openBillingPortal — desktop', () => {
  it('opens the personalized portal session in the OS browser', async () => {
    installWindow('desktop');
    installSignedInPortalUser();

    assert.deepEqual(await openBillingPortal(prereserveBillingPortalTab()), {
      outcome: 'opened',
      url: PORTAL_URL,
    });

    assert.deepEqual(probe.invocations, [
      { command: 'open_url', payload: { url: PORTAL_URL } },
    ]);
    // Regression guard for the reported bug: the WebView itself became the
    // Dodo portal, with no way back to the app.
    assert.deepEqual(probe.assigned, []);
    assert.deepEqual(probe.opened, []);
  });

  it('routes the signed-out fallback portal the same way', async () => {
    installWindow('desktop');

    const result = await openBillingPortal(prereserveBillingPortalTab());

    assert.deepEqual(result, { outcome: 'opened', url: 'https://customer.dodopayments.com' });
    assert.deepEqual(probe.invocations, [
      { command: 'open_url', payload: { url: 'https://customer.dodopayments.com' } },
    ]);
    assert.deepEqual(probe.assigned, []);
  });
});

describe('openBillingPortal — desktop failure', () => {
  it('reports open-failed rather than claiming it opened a session it did not', async () => {
    // A portal session was just minted server-side. Reporting 'opened' for a
    // handoff that never happened leaves the user staring at a dead button on
    // the billing surface with a live session behind it.
    installWindow('desktop');
    installSignedInPortalUser();
    probe.invokeRejects = true;
    probe.popupBlocked = true;

    assert.deepEqual(await openBillingPortal(prereserveBillingPortalTab()), {
      outcome: 'open-failed',
      url: PORTAL_URL,
    });
  });

  it('still reports opened when the native handoff succeeds', async () => {
    installWindow('desktop');
    installSignedInPortalUser();

    assert.deepEqual(await openBillingPortal(prereserveBillingPortalTab()), {
      outcome: 'opened',
      url: PORTAL_URL,
    });
  });
});

describe('openBillingPortal — web', () => {
  it('keeps navigating the pre-reserved tab, with no native bridge call', async () => {
    installWindow('web');
    installSignedInPortalUser();
    const reserved = prereserveBillingPortalTab();

    assert.deepEqual(await openBillingPortal(reserved), {
      outcome: 'opened',
      url: PORTAL_URL,
    });

    assert.equal(reserved?.location.href, PORTAL_URL);
    assert.deepEqual(probe.invocations, []);
  });
});
