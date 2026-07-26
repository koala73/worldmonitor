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

interface CapturedOutcomeCall {
  activationKey: string;
  claimNonce: string;
  outcome: {
    cohort?: 'day0';
    confirmedSteps: string[];
    skippedSteps: string[];
    /** Browser-refused steps (#5617); present-and-empty when nothing was blocked. */
    blockedSteps: string[];
    failedSteps: string[];
    revision: number;
    finalized: boolean;
  };
}

interface CapturedDay0Open {
  activationKey: string;
  claimNonce: string;
  sessionStartedAt: number;
}

async function gotoHarness(page: Page): Promise<void> {
  await page.goto('/tests/runtime-harness.html');
}

/** Open the interstitial SHELL directly with synthetic steps + injected callbacks. */
async function openShell(
  page: Page,
  confirmResult: 'verified' | 'failed' | 'blocked',
): Promise<void> {
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
      onConfirmStep: async () => result as 'verified' | 'failed' | 'blocked',
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
      options.openMcpClients = () => {};
      // Inject the retired opener too, so the "no apiKeys pointer" assertion is
      // about buildPowerExtra dropping it rather than about this harness never
      // supplying it — add() skips any pointer whose opener is absent (#5607).
      options.openApiKeys = () => {};
    }
    void (mod.openProActivationFlow as (o: unknown) => Promise<unknown>)(options);
  }, withOpeners);
  await expect(page.locator(OVERLAY)).toBeVisible({ timeout: 20_000 });
}

async function readCapturedEvents(page: Page): Promise<CapturedProEvent[]> {
  return page.evaluate(() => (window as unknown as { __proEvents: CapturedProEvent[] }).__proEvents);
}

async function readCapturedOutcomes(page: Page): Promise<CapturedOutcomeCall[]> {
  return page.evaluate(
    () => (window as unknown as { __proOutcomeCalls: CapturedOutcomeCall[] }).__proOutcomeCalls,
  );
}

async function readOutcomeAttempts(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __proOutcomeAttempts: number }).__proOutcomeAttempts,
  );
}

async function readDay0Opens(page: Page): Promise<CapturedDay0Open[]> {
  return page.evaluate(
    () => (window as unknown as { __proDay0Opens: CapturedDay0Open[] }).__proDay0Opens,
  );
}

type ClaimStatus = 'claimed' | 'not_eligible' | 'already_presented' | 'already_claimed';

async function runMarkerlessFlowHarness(
  page: Page,
  input: {
    claimStatus: ClaimStatus;
    activeLocal?: boolean;
    throwRead?: boolean;
    switchAfterClaim?: boolean;
    confirmResult?: boolean;
    confirmFailures?: number;
    neverResolveClaim?: boolean;
    outcomeAlwaysFails?: boolean;
  },
): Promise<{ result: string; claimCalls: number; confirmCalls: number }> {
  return await page.evaluate(async (scenario) => {
    const { initI18n } = await import('/src/services/i18n.ts');
    await initI18n();
    const mod = await import('/src/components/ProActivationInterstitial.ts');
    const w = window as unknown as {
      __proOutcomeCalls: CapturedOutcomeCall[];
      __proOutcomeAttempts: number;
    };
    w.__proOutcomeCalls = [];
    w.__proOutcomeAttempts = 0;
    let ownerChecks = 0;
    let claimCalls = 0;
    let confirmCalls = 0;
    const context = {
      config: {
        hasVerifiedEmailChannel: false,
        hasEmailDelivery: false,
        hasEnabledDigestRule: false,
        hasTunedDigestHour: false,
        hasWebPushChannel: false,
        hasWebPushDelivery: false,
        hasUsedPowerFeature: scenario.activeLocal === true,
      },
      capabilities: { webPushSupported: false },
      channels: [],
      channelsKnown: true,
      hasEnabledRule: false,
    };
    const result = await mod.openProActivationFlow(
      {
        accountUserId: 'markerless-user',
        accountEmail: 'markerless@worldmonitor.app',
        onlyIfUnactivated: true,
        expectedActivationKey: 'opaque-subscription',
        activationClaimNonce: 'tab-nonce',
        isAccountCurrent: () => {
          ownerChecks += 1;
          return !(scenario.switchAfterClaim && ownerChecks >= 3);
        },
      },
      {
        readContext: async () => {
          if (scenario.throwRead) throw new Error('strict read failed');
          return context;
        },
        claimPresentation: async () => {
          claimCalls += 1;
          if (scenario.neverResolveClaim) return await new Promise<never>(() => {});
          return scenario.claimStatus;
        },
        confirmPresentation: async () => {
          confirmCalls += 1;
          if (confirmCalls <= (scenario.confirmFailures ?? 0)) {
            throw new Error('confirm transport failed');
          }
          return scenario.confirmResult !== false;
        },
        recordOutcome: async (activationKey, claimNonce, outcome) => {
          w.__proOutcomeAttempts += 1;
          if (scenario.outcomeAlwaysFails) {
            throw new Error('record outcome transport failed');
          }
          w.__proOutcomeCalls.push({ activationKey, claimNonce, outcome });
          return true;
        },
        operationTimeoutMs: 20,
      },
    );
    return { result, claimCalls, confirmCalls };
  }, input);
}

test.describe('Pro activation flow — markerless first-cycle handoff', () => {
  test.beforeEach(async ({ page }) => {
    await gotoHarness(page);
  });

  test('strict config failure retries without claiming or opening', async ({ page }) => {
    const result = await runMarkerlessFlowHarness(page, {
      claimStatus: 'claimed',
      throwRead: true,
    });
    expect(result).toEqual({ result: 'retry', claimCalls: 0, confirmCalls: 0 });
    await expect(page.locator(OVERLAY)).toHaveCount(0);
    expect(await readCapturedOutcomes(page)).toEqual([]);
  });

  test('a stalled claim reaches the controller retry path within its deadline', async ({ page }) => {
    const result = await runMarkerlessFlowHarness(page, {
      claimStatus: 'claimed',
      neverResolveClaim: true,
    });
    expect(result).toEqual({ result: 'retry', claimCalls: 1, confirmCalls: 0 });
    await expect(page.locator(OVERLAY)).toHaveCount(0);
  });

  test('local Pro activation suppresses before the server claim', async ({ page }) => {
    const result = await runMarkerlessFlowHarness(page, {
      claimStatus: 'claimed',
      activeLocal: true,
    });
    expect(result).toEqual({ result: 'not-eligible', claimCalls: 0, confirmCalls: 0 });
    await expect(page.locator(OVERLAY)).toHaveCount(0);
  });

  test('claim outcomes preserve retryable and terminal meanings', async ({ page }) => {
    const claimedElsewhere = await runMarkerlessFlowHarness(page, {
      claimStatus: 'already_claimed',
    });
    expect(claimedElsewhere.result).toBe('retry');

    const alreadyPresented = await runMarkerlessFlowHarness(page, {
      claimStatus: 'already_presented',
    });
    expect(alreadyPresented.result).toBe('not-eligible');
    await expect(page.locator(OVERLAY)).toHaveCount(0);
  });

  test('a successful claim opens once and confirms the presentation', async ({ page }) => {
    const result = await runMarkerlessFlowHarness(page, { claimStatus: 'claimed' });
    expect(result).toEqual({ result: 'opened', claimCalls: 1, confirmCalls: 1 });
    await expect(page.locator(OVERLAY)).toBeVisible();
  });

  test('markerless progress and final exit persist exact lease-bound outcome snapshots', async ({ page }) => {
    const result = await runMarkerlessFlowHarness(page, { claimStatus: 'claimed' });
    expect(result).toEqual({ result: 'opened', claimCalls: 1, confirmCalls: 1 });

    await page.locator('.pro-activation-close').click();
    await expect(page.locator(SUMMARY)).toBeVisible();
    await page.locator(FINISH_BTN).click();

    await expect.poll(async () => (await readCapturedOutcomes(page)).length).toBe(2);
    expect(await readCapturedOutcomes(page)).toEqual([
      {
        activationKey: 'opaque-subscription',
        claimNonce: 'tab-nonce',
        outcome: {
          confirmedSteps: [],
          skippedSteps: ['brief', 'power'],
          // This harness presents no alerts step, so nothing can be blocked --
          // but the bucket must still be sent, pinning that every snapshot is a
          // full replacement rather than an omit-when-empty payload (#5617).
          blockedSteps: [],
          failedSteps: [],
          revision: 1,
          finalized: false,
        },
      },
      {
        activationKey: 'opaque-subscription',
        claimNonce: 'tab-nonce',
        outcome: {
          confirmedSteps: [],
          skippedSteps: ['brief', 'power'],
          blockedSteps: [],
          failedSteps: [],
          revision: 2,
          finalized: true,
        },
      },
    ]);
  });

  test('outcome-write retries exhaust and give up without blocking the flow', async ({ page }) => {
    // persistActivationOutcomeWithRetry doesn't distinguish transport errors
    // from permanent rejections -- every failure gets the same bounded
    // retry-then-give-up treatment (OUTCOME_WRITE_RETRY_DELAYS_MS = [250, 750]).
    // This locks in that give-up behavior: no test previously exercised a
    // recordOutcome call that fails every attempt.
    const opened = await runMarkerlessFlowHarness(page, {
      claimStatus: 'claimed',
      outcomeAlwaysFails: true,
    });
    expect(opened.result).toBe('opened');

    // finalizeAndShowSummary fires exactly one recordProgress() call
    // (revision 1, finalized: false).
    await page.locator('.pro-activation-close').click();
    await expect(page.locator(SUMMARY)).toBeVisible();

    // 1 initial attempt + 2 scheduled retries = 3 attempts, then the
    // fire-and-forget loop gives up (console.warn) instead of retrying
    // forever or throwing an unhandled rejection.
    await expect.poll(() => readOutcomeAttempts(page), { timeout: 5_000 }).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readOutcomeAttempts(page)).toBe(3);

    // Every attempt failed, so nothing was ever durably captured.
    expect(await readCapturedOutcomes(page)).toEqual([]);

    // The best-effort write failing never blocks the UI: the summary is
    // still interactive and finishing closes normally.
    await page.locator(FINISH_BTN).click();
    await expect(page.locator(OVERLAY)).toHaveCount(0);
  });

  test('lost confirmation ownership closes the flow and remains retryable', async ({ page }) => {
    const result = await runMarkerlessFlowHarness(page, {
      claimStatus: 'claimed',
      confirmResult: false,
    });
    expect(result).toEqual({ result: 'retry', claimCalls: 1, confirmCalls: 1 });
    await expect(page.locator(OVERLAY)).toHaveCount(0);
  });

  test('transient confirm failures still open after the retry delays', async ({ page }) => {
    const result = await runMarkerlessFlowHarness(page, {
      claimStatus: 'claimed',
      confirmFailures: 2,
    });
    expect(result).toEqual({ result: 'opened', claimCalls: 1, confirmCalls: 3 });
    await expect(page.locator(OVERLAY)).toBeVisible();
  });

  test('confirm failures beyond the retry schedule close the flow and remain retryable', async ({ page }) => {
    // One initial call plus every entry of PRESENTATION_CONFIRM_RETRY_DELAYS_MS
    // (250/750/1500ms real delays) fails → the flow gives up retrying.
    test.setTimeout(60_000);
    const result = await runMarkerlessFlowHarness(page, {
      claimStatus: 'claimed',
      confirmFailures: 4,
    });
    expect(result).toEqual({ result: 'retry', claimCalls: 1, confirmCalls: 4 });
    await expect(page.locator(OVERLAY)).toHaveCount(0);
  });

  test('interstitial stays unmounted while confirmation is pending, so a lost claim cannot leave a stray outcome write', async ({ page }) => {
    // Regression test for a presentedAt race (review of #5584/#5590):
    // openProActivationFlow used to open the interstitial (wiring
    // onProgress/onExit to recordProActivationOutcome) BEFORE awaiting
    // confirmPresentationWithRetry. If a step got interacted with in that
    // window and confirm then failed, recordProActivationOutcome's own
    // presentedAt backfill had already fired, permanently blocking a
    // legitimate re-claim via claimProActivationPresentation's
    // already_presented check -- even though the server never acknowledged
    // this presentation. The interstitial must not exist (and therefore
    // cannot record an outcome) until confirm actually succeeds.
    await page.evaluate(async () => {
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();
      const mod = await import('/src/components/ProActivationInterstitial.ts');
      const w = window as unknown as {
        __resolveProConfirm?: (ok: boolean) => void;
        __flowResult?: Promise<string>;
        __proOutcomeCalls: CapturedOutcomeCall[];
      };
      w.__proOutcomeCalls = [];
      const context = {
        config: {
          hasVerifiedEmailChannel: false,
          hasEmailDelivery: false,
          hasEnabledDigestRule: false,
          hasTunedDigestHour: false,
          hasWebPushChannel: false,
          hasWebPushDelivery: false,
          hasUsedPowerFeature: false,
        },
        capabilities: { webPushSupported: false },
        channels: [],
        channelsKnown: true,
        hasEnabledRule: false,
      };
      // Deliberately never resolves on its own -- held open so the test can
      // assert on interstitial state while confirm is genuinely in flight,
      // then resolve it explicitly to drive the failure path.
      w.__flowResult = mod.openProActivationFlow(
        {
          accountUserId: 'markerless-user',
          accountEmail: 'markerless@worldmonitor.app',
          onlyIfUnactivated: true,
          expectedActivationKey: 'opaque-subscription',
          activationClaimNonce: 'tab-nonce',
          isAccountCurrent: () => true,
        },
        {
          readContext: async () => context,
          claimPresentation: async () => 'claimed',
          confirmPresentation: () =>
            new Promise<boolean>((resolve) => {
              w.__resolveProConfirm = resolve;
            }),
          recordOutcome: async (activationKey, claimNonce, outcome) => {
            w.__proOutcomeCalls.push({ activationKey, claimNonce, outcome });
            return true;
          },
          // Large enough that withTimeout never races the manual resolve below.
          operationTimeoutMs: 20_000,
        },
      );
    });

    // Confirm is still pending: the interstitial must not be mounted, so
    // there is no onProgress/onConfirmStep handler a (simulated) click could
    // reach, and no way for a recordOutcome write to fire yet.
    await page.waitForTimeout(100);
    await expect(page.locator(OVERLAY)).toHaveCount(0);

    // Server rejects the claim (lost ownership) -- the real failure mode this
    // guards against.
    await page.evaluate(() => {
      (
        window as unknown as { __resolveProConfirm?: (ok: boolean) => void }
      ).__resolveProConfirm?.(false);
    });

    const result = await page.evaluate(
      () => (window as unknown as { __flowResult: Promise<string> }).__flowResult,
    );
    expect(result).toBe('retry');
    await expect(page.locator(OVERLAY)).toHaveCount(0);

    const outcomeCalls = await page.evaluate(
      () => (window as unknown as { __proOutcomeCalls: CapturedOutcomeCall[] }).__proOutcomeCalls,
    );
    expect(outcomeCalls).toEqual([]);
  });

  test('account switch after claim retries without opening or confirming', async ({ page }) => {
    const result = await runMarkerlessFlowHarness(page, {
      claimStatus: 'claimed',
      switchAfterClaim: true,
    });
    expect(result).toEqual({ result: 'retry', claimCalls: 1, confirmCalls: 0 });
    await expect(page.locator(OVERLAY)).toHaveCount(0);
    expect(await readCapturedOutcomes(page)).toEqual([]);
  });
});

type Day0Status = 'opened' | 'already_recorded' | 'not_eligible' | 'superseded';

/**
 * Drive the REAL day-0 (post-checkout) flow: `onlyIfUnactivated: false`, with
 * the subscription identity the controller now supplies for both cohorts.
 */
async function runDay0FlowHarness(
  page: Page,
  input: {
    day0Status?: Day0Status;
    day0Throws?: boolean;
    day0FailuresBeforeSuccess?: number;
    day0NeverResolves?: boolean;
    day0ResolveAfterMs?: number;
  } = {},
): Promise<{ result: string; claimCalls: number; confirmCalls: number; day0Calls: number }> {
  return await page.evaluate(async (scenario) => {
    const { initI18n } = await import('/src/services/i18n.ts');
    await initI18n();
    const mod = await import('/src/components/ProActivationInterstitial.ts');
    const w = window as unknown as {
      __proOutcomeCalls: CapturedOutcomeCall[];
      __proOutcomeAttempts: number;
      __proDay0Opens: CapturedDay0Open[];
    };
    w.__proOutcomeCalls = [];
    w.__proOutcomeAttempts = 0;
    w.__proDay0Opens = [];
    let claimCalls = 0;
    let confirmCalls = 0;
    let day0Calls = 0;
    const result = await mod.openProActivationFlow(
      {
        accountUserId: 'day0-user',
        accountEmail: 'day0@worldmonitor.app',
        onlyIfUnactivated: false,
        expectedActivationKey: 'opaque-subscription',
        activationClaimNonce: 'tab-nonce',
        activationSessionStartedAt: 1_725_000_000_000,
        isAccountCurrent: () => true,
      },
      {
        readContext: async () => ({
          config: {
            hasVerifiedEmailChannel: false,
            hasEmailDelivery: false,
            hasEnabledDigestRule: false,
            hasTunedDigestHour: false,
            hasWebPushChannel: false,
            hasWebPushDelivery: false,
            hasUsedPowerFeature: false,
          },
          capabilities: { webPushSupported: false },
          channels: [],
          channelsKnown: true,
          hasEnabledRule: false,
        }),
        claimPresentation: async () => {
          claimCalls += 1;
          return 'claimed';
        },
        confirmPresentation: async () => {
          confirmCalls += 1;
          return true;
        },
        openDay0Presentation: async (activationKey, claimNonce, sessionStartedAt) => {
          day0Calls += 1;
          w.__proDay0Opens.push({ activationKey, claimNonce, sessionStartedAt });
          if (scenario.day0NeverResolves) return await new Promise<never>(() => {});
          if (
            scenario.day0Throws ||
            day0Calls <= (scenario.day0FailuresBeforeSuccess ?? 0)
          ) {
            throw new Error('day-0 record transport failed');
          }
          if (scenario.day0ResolveAfterMs !== undefined) {
            await new Promise<void>((resolve) => setTimeout(resolve, scenario.day0ResolveAfterMs));
          }
          return scenario.day0Status ?? 'opened';
        },
        recordOutcome: async (activationKey, claimNonce, outcome) => {
          w.__proOutcomeAttempts += 1;
          w.__proOutcomeCalls.push({ activationKey, claimNonce, outcome });
          return true;
        },
        operationTimeoutMs: 200,
      },
    );
    return { result, claimCalls, confirmCalls, day0Calls };
  }, input);
}

test.describe('Pro activation flow — day-0 outcome rows (#5621)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoHarness(page);
  });

  test('day-0 opens its own record and persists cohort-tagged outcome snapshots', async ({ page }) => {
    // Before #5621 the day-0 path ran with no activation key or nonce, so
    // persistActivationOutcomeWithRetry returned early and the entire
    // post-checkout cohort was absent from Convex.
    const result = await runDay0FlowHarness(page);
    expect(result).toEqual({ result: 'opened', claimCalls: 0, confirmCalls: 0, day0Calls: 1 });
    await expect(page.locator(OVERLAY)).toBeVisible();

    await page.locator('.pro-activation-close').click();
    await expect(page.locator(SUMMARY)).toBeVisible();
    await page.locator(FINISH_BTN).click();

    await expect.poll(async () => (await readCapturedOutcomes(page)).length).toBe(2);
    expect(await readCapturedOutcomes(page)).toEqual([
      {
        activationKey: 'opaque-subscription',
        claimNonce: 'tab-nonce',
        outcome: {
          cohort: 'day0',
          confirmedSteps: [],
          skippedSteps: ['brief', 'power'],
          // Same full-replacement contract the markerless snapshots pin
          // (#5617): the day-0 payload carries every bucket, so the cohort tag
          // rides alongside them rather than replacing any.
          blockedSteps: [],
          failedSteps: [],
          revision: 1,
          finalized: false,
        },
      },
      {
        activationKey: 'opaque-subscription',
        claimNonce: 'tab-nonce',
        outcome: {
          cohort: 'day0',
          confirmedSteps: [],
          skippedSteps: ['brief', 'power'],
          blockedSteps: [],
          failedSteps: [],
          revision: 2,
          finalized: true,
        },
      },
    ]);
  });

  test('day-0 never touches the markerless claim/confirm lease', async ({ page }) => {
    // The lease is what makes the retro backfill fire exactly once per
    // subscription. Day-0 borrowing it would consume that budget and lock the
    // subscriber out of the backfill they may still need (#5600).
    const result = await runDay0FlowHarness(page);
    expect(result.claimCalls).toBe(0);
    expect(result.confirmCalls).toBe(0);
  });

  test('a late successful day-0 open still flushes queued finalized snapshots', async ({ page }) => {
    const result = await runDay0FlowHarness(page, { day0ResolveAfterMs: 350 });
    expect(result.result).toBe('opened');
    await expect(page.locator(OVERLAY)).toBeVisible();

    // Both snapshots are queued before the open resolves, and after the 200ms
    // observation deadline. A timeout warning must not turn that eventual
    // server success into a permanent refusal.
    await page.locator('.pro-activation-close').click();
    await expect(page.locator(SUMMARY)).toBeVisible();
    await page.locator(FINISH_BTN).click();

    await expect.poll(async () => (await readCapturedOutcomes(page)).length).toBe(2);
    expect((await readCapturedOutcomes(page)).map(({ outcome }) => ({
      revision: outcome.revision,
      finalized: outcome.finalized,
    }))).toEqual([
      { revision: 1, finalized: false },
      { revision: 2, finalized: true },
    ]);
  });

  test('rejected opens retry with one identity, then flush queued snapshots after success', async ({ page }) => {
    const result = await runDay0FlowHarness(page, { day0FailuresBeforeSuccess: 2 });
    expect(result.result).toBe('opened');
    await expect(page.locator(OVERLAY)).toBeVisible();

    await page.locator('.pro-activation-close').click();
    await expect(page.locator(SUMMARY)).toBeVisible();
    await page.locator(FINISH_BTN).click();

    await expect.poll(async () => (await readDay0Opens(page)).length).toBe(3);
    expect(await readDay0Opens(page)).toEqual(Array.from({ length: 3 }, () => ({
      activationKey: 'opaque-subscription',
      claimNonce: 'tab-nonce',
      sessionStartedAt: 1_725_000_000_000,
    })));
    await expect.poll(async () => (await readCapturedOutcomes(page)).length).toBe(2);
    expect((await readCapturedOutcomes(page)).map(({ outcome }) => ({
      revision: outcome.revision,
      finalized: outcome.finalized,
    }))).toEqual([
      { revision: 1, finalized: false },
      { revision: 2, finalized: true },
    ]);
  });

  test.describe('a refused or unreachable day-0 record never blocks the welcome flow', () => {
    for (const [name, day0Status] of [
      ['server refuses (already finalized)', { day0Status: 'already_recorded' as const }],
      ['server refuses (ineligible)', { day0Status: 'not_eligible' as const }],
      ['server refuses (superseded)', { day0Status: 'superseded' as const }],
    ] as const) {
      test(name, async ({ page }) => {
        const result = await runDay0FlowHarness(page, day0Status);
        // Post-checkout onboarding is the product; the ledger is telemetry.
        // It must open regardless, and never return the 'retry' that the
        // markerless path uses when its lease is in doubt.
        expect(result.result).toBe('opened');
        await expect(page.locator(OVERLAY)).toBeVisible();

        await page.locator('.pro-activation-close').click();
        await expect(page.locator(SUMMARY)).toBeVisible();
        await page.locator(FINISH_BTN).click();
        await expect(page.locator(OVERLAY)).toHaveCount(0);

        expect((await readDay0Opens(page)).length).toBe(1);
        expect(await readCapturedOutcomes(page)).toEqual([]);
        expect(await readOutcomeAttempts(page)).toBe(0);
      });
    }

    test('permanent transport rejection performs the bounded attempt count', async ({ page }) => {
      const result = await runDay0FlowHarness(page, { day0Throws: true });
      expect(result.result).toBe('opened');
      await expect(page.locator(OVERLAY)).toBeVisible();

      await page.locator('.pro-activation-close').click();
      await expect(page.locator(SUMMARY)).toBeVisible();
      await page.locator(FINISH_BTN).click();
      await expect(page.locator(OVERLAY)).toHaveCount(0);

      await expect.poll(async () => (await readDay0Opens(page)).length).toBe(3);
      expect(await readCapturedOutcomes(page)).toEqual([]);
      expect(await readOutcomeAttempts(page)).toBe(0);
    });

    test('a hung request stays pending without blocking or writing', async ({ page }) => {
      const result = await runDay0FlowHarness(page, { day0NeverResolves: true });
      expect(result.result).toBe('opened');
      await expect(page.locator(OVERLAY)).toBeVisible();

      await page.locator('.pro-activation-close').click();
      await expect(page.locator(SUMMARY)).toBeVisible();
      await page.locator(FINISH_BTN).click();
      await expect(page.locator(OVERLAY)).toHaveCount(0);
      await page.waitForTimeout(400);

      expect((await readDay0Opens(page)).length).toBe(1);
      expect(await readCapturedOutcomes(page)).toEqual([]);
      expect(await readOutcomeAttempts(page)).toBe(0);
    });
  });
});

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

  test('confirm resolves to blocked → blocked state, no dead-end retry (#5609)', async ({
    page,
  }) => {
    await gotoHarness(page);
    await openShell(page, 'blocked');

    // Advance to alerts — the step a browser permission can actually block.
    await page.locator(SKIP_BTN).click();
    await expect(page.locator(PROGRESS)).toContainText('2 of 3');
    await page.locator(CONFIRM_BTN).click();

    // Blocked badge + the site-settings instructions, not the generic error.
    await expect(page.locator('.pro-activation-status.status-blocked')).toContainText('Blocked');
    await expect(page.locator('.pro-activation-note.note-warn')).toContainText('site settings');
    await expect(page.locator('.pro-activation-note.note-error')).toHaveCount(0);

    // Browsers never re-prompt after a deny, so "Try again" must be gone and
    // the step must expose exactly one way forward.
    await expect(page.locator(CONFIRM_BTN)).toHaveCount(0);
    await expect(page.locator(SKIP_BTN)).toHaveCount(0);
    await expect(page.locator(ADVANCE_SKIP_BTN)).toBeVisible();

    // Continuing resolves it as its own 'blocked' outcome (same as a step
    // blocked at mount) — never 'failed', which the summary would report as
    // "we couldn't set up", and never a plain 'skipped', which would make the
    // denial indistinguishable from disinterest in the durable record (#5617).
    await page.locator(ADVANCE_SKIP_BTN).click();
    await expect(page.locator(PROGRESS)).toContainText('3 of 3');
    await page.locator(SKIP_BTN).click();
    await expect(page.locator(SUMMARY)).toBeVisible();
    await expect(page.locator('.pro-activation-summary-line.status-failed')).toHaveCount(0);

    await page.locator(FINISH_BTN).click();
    const results = await page.evaluate(
      () => (window as unknown as { __proExit: Array<{ outcome: string }> }).__proExit,
    );
    // Only the middle (alerts) step was refused by the browser; the other two
    // are ordinary skips. Asserting all three as 'skipped' is exactly the
    // collapse #5617 removed.
    expect(results.map((r) => r.outcome)).toEqual(['skipped', 'blocked', 'skipped']);
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

  test('a failed confirm fires step-failed telemetry and is never reported as a skip', async ({
    page,
  }) => {
    // #5600: every per-step write in this harness fails (authFetch throws with
    // no Clerk session — see the HARNESS NOTE), which is exactly the day-0
    // production shape. The failure must reach Umami as its own event; before
    // the fix the only trace was a `step-skipped`, so the funnel counted broken
    // writes as user disinterest.
    await gotoHarness(page);
    await openFlow(page, /* withOpeners */ false);

    await expect(page.locator(CONFIRM_BTN)).toBeVisible();
    await page.locator(CONFIRM_BTN).click();
    await expect(page.locator('.pro-activation-status.status-failed')).toBeVisible();

    const afterConfirm = await readCapturedEvents(page);
    const failed = afterConfirm.filter((e) => e.event === 'pro-activation-step-failed');
    expect(failed.length).toBe(1);
    expect(failed[0]?.stepId).toBe('brief');
    expect(afterConfirm.some((e) => e.event === 'pro-activation-step-skipped')).toBe(false);

    // Moving on from a failed step records the outcome as `failed`; it must not
    // also emit a skip for the same step.
    await page.locator(SKIP_BTN).first().click();
    const afterSkip = await readCapturedEvents(page);
    expect(
      afterSkip.some((e) => e.event === 'pro-activation-step-skipped' && e.stepId === 'brief'),
    ).toBe(false);
    expect(
      afterSkip.filter((e) => e.event === 'pro-activation-step-failed' && e.stepId === 'brief')
        .length,
    ).toBe(1);
  });

  test('a failed confirm reaches Sentry with the step and activation-path tags', async ({
    page,
  }) => {
    // #5600 blind spot 3: the confirm catch blocks only console.warn'd, and
    // sentry-init.ts has no captureConsole integration — so the error text
    // never left the browser. Drives the REAL deferred-Sentry queue with an
    // injected loader (timers collapsed so the 10s audit-window delay does not
    // dominate the run).
    await gotoHarness(page);
    await page.evaluate(async () => {
      const w = window as unknown as {
        __sentryCaptures: Array<{ message: string; tags?: Record<string, string> }>;
      };
      w.__sentryCaptures = [];
      const realSetTimeout = window.setTimeout.bind(window);
      window.setTimeout = ((fn: TimerHandler, ms?: number, ...rest: unknown[]) =>
        realSetTimeout(fn as () => void, (ms ?? 0) >= 1_000 ? 0 : ms, ...rest)) as typeof setTimeout;
      (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback = (
        cb: () => void,
      ) => realSetTimeout(cb, 0);
      const sentryDefer = await import('/src/bootstrap/sentry-defer.ts');
      sentryDefer._resetSentryDeferStateForTests();
      sentryDefer._setSentryLoaderForTests(async () => ({
        captureException: (err: unknown, ctx?: { tags?: Record<string, string> }) => {
          w.__sentryCaptures.push({
            message: err instanceof Error ? err.message : String(err),
            tags: ctx?.tags,
          });
          return 'test-event-id';
        },
      }) as never);
      // Deliberately NOT calling scheduleSentryInit() here. Production defers
      // real init ~10s from page load (main.ts) and the day-0 interstitial opens
      // on that same post-checkout load, so a failing step enqueues into the
      // pending buffer rather than dispatching straight through. Awaiting init
      // first would exercise enqueueSentryCall's immediate branch — not the one
      // this scenario depends on. reportActivationStepFailure kicks init itself.
    });

    await openFlow(page, /* withOpeners */ false);
    await expect(page.locator(CONFIRM_BTN)).toBeVisible();
    await page.locator(CONFIRM_BTN).click();
    await expect(page.locator('.pro-activation-status.status-failed')).toBeVisible();

    const readCaptures = () =>
      page.evaluate(
        () =>
          (window as unknown as {
            __sentryCaptures: Array<{ message: string; tags?: Record<string, string> }>;
          }).__sentryCaptures,
      );

    // reportActivationStepFailure kicks the idempotent scheduleSentryInit() itself
    // (#5600), so the capture must arrive without the test driving init — that
    // explicit kick is what stops a user who closes the tab inside the ~10s
    // deferral window from losing the only signal for a failed activation.
    await expect.poll(async () => (await readCaptures()).length).toBeGreaterThan(0);

    const captures = await readCaptures();
    const briefCapture = captures.find((c) => c.tags?.step === 'brief');
    expect(briefCapture).toBeTruthy();
    expect(briefCapture?.tags).toMatchObject({
      component: 'pro-activation',
      step: 'brief',
      stage: 'brief-confirm',
      activation_path: 'day0',
    });
    // Assert the message this harness actually produces. It fails at
    // assertExpectedAccount (src/services/notification-channels.ts:55) — no Clerk
    // user in the harness — so there is no HTTP status to carry here; the
    // `set email channel: <status>` shape lives on the post-auth path. A bare
    // length check passed on literally any string, including an empty-ish one.
    expect(briefCapture?.message).toContain('Authenticated account changed during notification setup');
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

    // #5607: Pro is apiAccess:false / mcpAccess:true, so the third pointer sells
    // MCP setup — never "API & MCP keys" deep-linked at the API-plan upsell.
    await expect(
      page.locator('.pro-activation-pointer[data-pointer="mcpClients"]'),
    ).toContainText('Set up MCP');
    await expect(page.locator('.pro-activation-pointer[data-pointer="apiKeys"]')).toHaveCount(0);

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
  test('anonymous boot without a pending marker does not open or synthesize one', async ({
    page,
  }) => {
    // A failed / non-success checkout return writes NO pending marker (only the
    // success path does). Markerless onboarding still requires an authenticated,
    // first-cycle Pro subscription carrying server-derived eligibility.
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
