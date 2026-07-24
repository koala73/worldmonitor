import { expect, test, type Page } from '@playwright/test';

/**
 * Pro Activation Onboarding — end-to-end coverage.
 *
 * HARNESS NOTE (honest gaps, no faked assertions):
 * The interstitial only opens at boot once the live entitlement snapshot flips
 * to Pro, and that snapshot is delivered ONLY by the Convex real-time
 * subscription behind a Clerk session (see src/services/entitlements.ts —
 * `currentState` is module-private with no injection hook). The e2e dev server
 * has neither, so the boot mount decision correctly resolves to `keep`
 * (still-settling) for an anonymous visitor and the interstitial never opens
 * from a real `page.goto('/')`. The decision flowchart itself
 * (`decideActivationMount`, incl. fire-once suppression) is exhaustively
 * unit-tested in tests/pro-activation-state.test.mts.
 *
 * So the flow/interstitial scenarios here drive the REAL modules directly on the
 * runtime harness page (the same dynamic-import pattern as
 * e2e/keyword-spike-flow.spec.ts), which honestly exercises the component's
 * rendering, step-through, exit summary, the finish-setup chip, and the funnel
 * telemetry wiring — nothing is stubbed except the values a live Clerk/Convex
 * session would otherwise provide. The boot-gating scenarios drive the real app
 * and assert the interstitial stays closed for the states that must not open it.
 *
 * A further real-service gap: every per-step write goes through `authFetch`,
 * which throws before it ever hits the network when `getClerkToken()` is null
 * (no Clerk session). So a confirm cannot resolve to 'verified' through the real
 * flow in this harness; the happy-path step-through + verified exit summary is
 * therefore driven at the interstitial-shell layer with a verified confirm stub
 * (the shell is the component that renders those states). The flow → service
 * write deltas are covered by the buildBriefDigestPayload / buildCriticalAlertsPayload
 * unit tests.
 */

// Storage keys — mirror src/services/pro-activation-state.ts.
const MARKER_KEY = 'wm-pro-activation-pending-v1';
const FIRE_ONCE_KEY = 'wm-pro-activation-shown-v1';
const CHIP_DISMISS_KEY = 'wm-pro-activation-chip-dismissed-v1';
// PRO_MONTHLY — mirrors PRO_PRODUCT_IDS[0] in the leaf.
const PRO_MONTHLY_PRODUCT_ID = 'pdt_0Nbtt71uObulf7fGXhQup';

const OVERLAY = '.pro-activation-overlay';
const PROGRESS = '.pro-activation-progress';
const SUMMARY = '.pro-activation-summary';
const CHIP = '#pro-activation-finish-chip';
const CONFIRM_BTN = '.pro-activation-primary[data-action="confirm"]';
const SKIP_BTN = '.pro-activation-skip';
const ADVANCE_SKIP_BTN = '.pro-activation-primary[data-action="advance-skip"]';
const FINISH_BTN = '.pro-activation-primary[data-action="finish"]';

interface CapturedProEvent {
  event: string;
  stepId?: string;
  exit?: {
    completion?: string;
    verified?: number;
    pending?: number;
    failed?: number;
    total?: number;
  };
}

async function gotoHarness(page: Page): Promise<void> {
  await page.goto('/tests/runtime-harness.html');
}

/** Open the interstitial SHELL directly with synthetic steps + injected callbacks. */
async function openShell(page: Page, confirmResult: 'verified' | 'failed'): Promise<void> {
  await page.evaluate(async (result) => {
    const { initI18n } = await import('/src/services/i18n.ts');
    await initI18n();
    const mod = await import('/src/components/ProActivationInterstitial.ts');
    const w = window as unknown as { __proExit: unknown };
    w.__proExit = null;
    mod.openProActivationInterstitial({
      steps: [
        { id: 'brief', state: 'confirmable' },
        { id: 'alerts', state: 'confirmable' },
        { id: 'power', state: 'confirmable' },
      ],
      accountEmail: 'e2e@worldmonitor.app',
      onConfirmStep: async () => result as 'verified' | 'failed',
      onSkipStep: () => {},
      onExit: (results) => {
        w.__proExit = results;
      },
    });
  }, confirmResult);
  await expect(page.locator(OVERLAY)).toBeVisible();
}

/**
 * Open the REAL high-level flow. Fire-and-forget inside the page: the flow
 * awaits a ~2s degraded-config read (getChannelsData throws with no Clerk
 * token), so the overlay is polled for from the test side rather than awaited.
 */
async function openFlow(page: Page, withOpeners: boolean): Promise<void> {
  await page.evaluate(async (openers) => {
    const { initI18n } = await import('/src/services/i18n.ts');
    await initI18n();
    const mod = await import('/src/components/ProActivationInterstitial.ts');
    const w = window as unknown as { __proEvents: CapturedProEvent[] };
    w.__proEvents = [];
    const options: Record<string, unknown> = {
      accountUserId: 'e2e-user',
      accountEmail: 'e2e@worldmonitor.app',
      isAccountCurrent: () => true,
      onEvent: (event: string, stepId?: string, exit?: CapturedProEvent['exit']) => {
        w.__proEvents.push({ event, stepId, exit });
      },
    };
    if (openers) {
      options.openWidgetBuilder = () => {};
      options.openAiAnalyst = () => {};
      options.openApiKeys = () => {};
    }
    void (mod.openProActivationFlow as (o: unknown) => Promise<boolean>)(options);
  }, withOpeners);
  await expect(page.locator(OVERLAY)).toBeVisible({ timeout: 20_000 });
}

async function readCapturedEvents(page: Page): Promise<CapturedProEvent[]> {
  return page.evaluate(() => (window as unknown as { __proEvents: CapturedProEvent[] }).__proEvents);
}

test.describe('Pro activation interstitial — shell step flow', () => {
  test('happy path: confirm every step → verified exit summary → dashboard', async ({ page }) => {
    await gotoHarness(page);
    await openShell(page, 'verified');

    await expect(page.locator('.pro-activation-badge')).toBeVisible();
    await expect(page.locator(PROGRESS)).toContainText('1 of 3');

    await page.locator(CONFIRM_BTN).click();
    await expect(page.locator(PROGRESS)).toContainText('2 of 3');

    await page.locator(CONFIRM_BTN).click();
    await expect(page.locator(PROGRESS)).toContainText('3 of 3');

    await page.locator(CONFIRM_BTN).click();

    // Exit summary: three delivery-honest "running" lines, all verified.
    await expect(page.locator(SUMMARY)).toBeVisible();
    await expect(page.locator('.pro-activation-summary-line.status-verified')).toHaveCount(3);

    await page.locator(FINISH_BTN).click();
    await expect(page.locator(OVERLAY)).toHaveCount(0);

    const results = await page.evaluate(
      () => (window as unknown as { __proExit: Array<{ outcome: string }> }).__proExit,
    );
    expect(results.map((r) => r.outcome)).toEqual(['confirmed', 'confirmed', 'confirmed']);
  });

  test('skip every step → pending exit summary reflects nothing set up', async ({ page }) => {
    await gotoHarness(page);
    await openShell(page, 'verified');

    // Each skip advances to the next step's freshly-rendered skip button.
    await page.locator(SKIP_BTN).click();
    await page.locator(SKIP_BTN).click();
    await page.locator(SKIP_BTN).click();

    await expect(page.locator(SUMMARY)).toBeVisible();
    await expect(page.locator('.pro-activation-summary-line.status-pending')).toHaveCount(3);

    // onExit fires on "Go to my dashboard" (finish), not when the summary renders.
    await page.locator(FINISH_BTN).click();
    await expect(page.locator(OVERLAY)).toHaveCount(0);

    const results = await page.evaluate(
      () => (window as unknown as { __proExit: Array<{ outcome: string }> }).__proExit,
    );
    expect(results.map((r) => r.outcome)).toEqual(['skipped', 'skipped', 'skipped']);
  });

  test('confirm resolves to failed → failed badge + retry CTA, then Escape rolls it into the exit summary', async ({
    page,
  }) => {
    await gotoHarness(page);
    await openShell(page, 'failed');

    await page.locator(CONFIRM_BTN).click();

    // Failed state: distinct status badge + error note, primary CTA relabels to retry.
    await expect(page.locator('.pro-activation-status.status-failed')).toContainText("Didn't work");
    await expect(page.locator('.pro-activation-note.note-error')).toBeVisible();
    await expect(page.locator(CONFIRM_BTN)).toContainText('Try again');

    // Escape abandons the flow: the failed step keeps its 'failed' outcome, the
    // remaining steps are marked skipped, and the summary renders both statuses.
    await page.keyboard.press('Escape');
    await expect(page.locator(SUMMARY)).toBeVisible();
    await expect(page.locator('.pro-activation-summary-line.status-failed')).toHaveCount(1);
    await expect(page.locator('.pro-activation-summary-line.status-pending')).toHaveCount(2);
  });

  test('dismiss is blocked while a confirmation write is in flight', async ({ page }) => {
    await gotoHarness(page);
    await page.evaluate(async () => {
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();
      const mod = await import('/src/components/ProActivationInterstitial.ts');
      const w = window as unknown as {
        __resolveProConfirm?: (result: 'verified') => void;
        __proExit: unknown;
      };
      w.__proExit = null;
      mod.openProActivationInterstitial({
        steps: [{ id: 'brief', state: 'confirmable' }],
        accountEmail: 'e2e@worldmonitor.app',
        onConfirmStep: () =>
          new Promise<'verified'>((resolve) => {
            w.__resolveProConfirm = resolve;
          }),
        onSkipStep: () => {},
        onExit: (results) => {
          w.__proExit = results;
        },
      });
    });

    await page.locator(CONFIRM_BTN).click();
    await expect(page.locator(CONFIRM_BTN)).toBeDisabled();
    await expect(page.locator('.pro-activation-close')).toBeDisabled();

    await page.keyboard.press('Escape');
    await expect(page.locator(OVERLAY)).toBeVisible();
    await expect(page.locator(SUMMARY)).toHaveCount(0);

    await page.evaluate(() => {
      (
        window as unknown as { __resolveProConfirm?: (result: 'verified') => void }
      ).__resolveProConfirm?.('verified');
    });
    await expect(page.locator(SUMMARY)).toBeVisible();
    await expect(page.locator('.pro-activation-summary-line.status-verified')).toHaveCount(1);

    await page.locator(FINISH_BTN).click();
    const results = await page.evaluate(
      () => (window as unknown as { __proExit: Array<{ outcome: string }> }).__proExit,
    );
    expect(results.map((result) => result.outcome)).toEqual(['confirmed']);
  });
});

test.describe('Pro activation flow — telemetry + finish-setup chip', () => {
  test('skip-all through the real flow does not leak a chip after the owner session changes', async ({
    page,
  }) => {
    await gotoHarness(page);
    await openFlow(page, /* withOpeners */ false);

    // Walk to the summary skipping every step. `skip` buttons on confirmable
    // brief/alerts; the power step replaces its primary action, so its
    // "Continue" carries data-action="advance-skip". Tolerant of the alerts
    // step being absent when the headless runtime reports no web push.
    for (let i = 0; i < 5; i += 1) {
      if (await page.locator(SUMMARY).isVisible().catch(() => false)) break;
      const skip = page.locator(SKIP_BTN);
      const cont = page.locator(ADVANCE_SKIP_BTN);
      if (await skip.count()) await skip.first().click();
      else if (await cont.count()) await cont.first().click();
      else break;
    }

    await expect(page.locator(SUMMARY)).toBeVisible();
    await page.locator(FINISH_BTN).click();
    await expect(page.locator(OVERLAY)).toHaveCount(0);

    // Telemetry: entered fired once, at least one skip fired, exit carries the
    // aggregate completion (nothing verified → 'none').
    const events = await readCapturedEvents(page);
    expect(events[0]?.event).toBe('pro-activation-entered');
    expect(events.some((e) => e.event === 'pro-activation-step-skipped')).toBe(true);
    const exit = events.find((e) => e.event === 'pro-activation-exit');
    expect(exit).toBeTruthy();
    expect(exit?.exit?.completion).toBe('none');

    // The harness has no Clerk session. The flow is owned by the synthetic
    // account passed above, so its unfinished state must not leak into an
    // anonymous/different-account chip.
    await expect(page.locator(CHIP)).toHaveCount(0);
    const dismissed = await page.evaluate((k) => localStorage.getItem(k), CHIP_DISMISS_KEY);
    expect(dismissed).toBeNull();
  });

  test('power-toolkit pointer confirms the step and fires step-confirmed telemetry', async ({
    page,
  }) => {
    await gotoHarness(page);
    await openFlow(page, /* withOpeners */ true);

    // Skip forward until the power step's injected pointer is on screen.
    const pointer = page.locator('.pro-activation-pointer[data-pointer="widgets"]');
    for (let i = 0; i < 5; i += 1) {
      if (await pointer.count()) break;
      const skip = page.locator(SKIP_BTN);
      if (await skip.count()) await skip.first().click();
      else break;
    }
    await expect(pointer).toBeVisible();

    // Clicking a pointer confirms the power step (stepConfirmed) and finishes
    // the flow (a deep-link closes the full-screen overlay first).
    await pointer.click();
    await expect(page.locator(OVERLAY)).toHaveCount(0);

    const events = await readCapturedEvents(page);
    expect(events[0]?.event).toBe('pro-activation-entered');
    expect(
      events.some((e) => e.event === 'pro-activation-step-confirmed' && e.stepId === 'power'),
    ).toBe(true);
    const exit = events.find((e) => e.event === 'pro-activation-exit');
    expect(exit).toBeTruthy();
    // One step verified (power), the rest left pending → partial completion.
    expect(exit?.exit?.completion).toBe('partial');
  });
});

test.describe('Pro activation — notification context', () => {
  test('selects the current variant instead of the first alert rule', async ({ page }) => {
    await gotoHarness(page);
    const result = await page.evaluate(async () => {
      const { SITE_VARIANT } = await import('/src/config/variant.ts');
      const { activationContextFromChannelsData } = await import(
        '/src/components/ProActivationInterstitial.ts'
      );
      return activationContextFromChannelsData(
        {
          channels: [
            { channelType: 'email', verified: true, linkedAt: 1 },
            { channelType: 'web_push', verified: true, linkedAt: 1 },
          ],
          alertRules: [
            {
              variant: 'not-the-current-variant',
              enabled: true,
              eventTypes: [],
              sensitivity: 'all',
              channels: ['email', 'web_push'],
              digestMode: 'daily',
              digestHour: 6,
            },
            {
              variant: SITE_VARIANT,
              enabled: true,
              eventTypes: [],
              sensitivity: 'critical',
              channels: [],
              digestMode: 'weekly',
              digestHour: 8,
            },
          ],
        },
        { webPushSupported: true, pushPermission: 'granted' },
      );
    });

    expect(result.config.hasEnabledDigestRule).toBe(true);
    expect(result.config.hasTunedDigestHour).toBe(false);
    expect(result.config.hasEmailDelivery).toBe(false);
    expect(result.config.hasWebPushDelivery).toBe(false);
    expect(result.channels).toEqual(['email', 'web_push']);
  });

  test('requires verified channel rows to be linked by the current rule', async ({ page }) => {
    await gotoHarness(page);
    const result = await page.evaluate(async () => {
      const { SITE_VARIANT } = await import('/src/config/variant.ts');
      const { activationContextFromChannelsData } = await import(
        '/src/components/ProActivationInterstitial.ts'
      );
      return activationContextFromChannelsData(
        {
          channels: [
            { channelType: 'email', verified: true, linkedAt: 1 },
            { channelType: 'web_push', verified: true, linkedAt: 1 },
          ],
          alertRules: [
            {
              variant: SITE_VARIANT,
              enabled: true,
              eventTypes: [],
              sensitivity: 'critical',
              channels: ['email'],
              digestMode: 'daily',
              digestHour: 8,
            },
          ],
        },
        { webPushSupported: true, pushPermission: 'granted' },
      );
    });

    expect(result.config.hasVerifiedEmailChannel).toBe(true);
    expect(result.config.hasWebPushChannel).toBe(true);
    expect(result.config.hasEmailDelivery).toBe(true);
    expect(result.config.hasWebPushDelivery).toBe(false);
  });
});

test.describe('Pro activation — boot gating (real app)', () => {
  test('no pending marker → interstitial never opens and no marker is written', async ({
    page,
  }) => {
    // A failed / non-success checkout return writes NO pending marker (only the
    // success path does), so this also covers "failed checkout return → no
    // interstitial": with no marker, the boot decision is `none`.
    await page.addInitScript(() => {
      localStorage.setItem('worldmonitor-variant', 'happy');
    });
    await page.goto('/');
    await page.waitForTimeout(4_000); // let the deferred mount check run

    await expect(page.locator(OVERLAY)).toHaveCount(0);
    const marker = await page.evaluate((k) => localStorage.getItem(k), MARKER_KEY);
    expect(marker).toBeNull();
  });

  test('pending Pro marker but anonymous (no live entitlement) → stays settling, marker preserved', async ({
    page,
  }) => {
    await page.addInitScript(
      ({ key, pid }) => {
        localStorage.setItem('worldmonitor-variant', 'happy');
        localStorage.setItem(key, JSON.stringify({ productId: pid, createdAt: Date.now() }));
      },
      { key: MARKER_KEY, pid: PRO_MONTHLY_PRODUCT_ID },
    );
    await page.goto('/');
    await page.waitForTimeout(4_000);

    // Entitlement never flips to Pro in e2e → decision is `keep`: no overlay,
    // and the marker is NOT cleared (settling never reaps a real marker).
    await expect(page.locator(OVERLAY)).toHaveCount(0);
    const marker = await page.evaluate((k) => localStorage.getItem(k), MARKER_KEY);
    expect(marker).not.toBeNull();
  });

  test('unresolved auth never leaks a fire-once setup chip to the wrong viewer', async ({
    page,
  }) => {
    // Post-completion storage state: the marker was cleared and a fire-once
    // record written. A later boot has nothing to mount (decision `none`).
    // Full fire-once SUPPRESSION with a live marker+entitlement+subscription is
    // covered by decideActivationMount unit tests (needs Convex here).
    await page.addInitScript(
      ({ key }) => {
        localStorage.setItem('worldmonitor-variant', 'happy');
        localStorage.setItem(key, JSON.stringify({ subscriptionKey: 'sub_e2e_1', shownAt: Date.now() }));
      },
      { key: FIRE_ONCE_KEY },
    );
    await page.goto('/');
    await page.waitForTimeout(4_000);

    await expect(page.locator(OVERLAY)).toHaveCount(0);

    await expect(page.locator(CHIP)).toHaveCount(0);
    const stored = await page.evaluate((key) => localStorage.getItem(key), FIRE_ONCE_KEY);
    expect(stored).not.toContain('userId');
  });
});
