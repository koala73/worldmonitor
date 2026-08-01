import { expect, test, type Request } from '@playwright/test';
import { assertSignedOutAuthHydrationKeepsHeaderStable } from './header-reservation';
import {
  apiPath,
  captureLocalApiResponse,
  isLocalApiUrl,
  type ApiDiagnostic,
} from './variant-live-smoke-response-capture';
import { PREMIUM_RPC_PATHS } from '../src/shared/premium-paths';

type VariantName = 'full' | 'tech' | 'finance' | 'commodity' | 'energy' | 'happy';

type PanelDiagnostic = {
  id: string;
  state: 'error' | 'unavailable' | 'loading' | 'stale';
  text: string;
  title: string;
};

const EXPECTED_BOOT_PANELS: Record<VariantName, string[]> = {
  full: ['live-news', 'insights', 'strategic-posture'],
  tech: ['live-news', 'insights', 'ai', 'tech'],
  finance: ['live-news', 'insights', 'markets'],
  commodity: ['live-news', 'insights', 'commodity-news', 'markets'],
  energy: ['chokepoint-strip', 'pipeline-status', 'live-news'],
  happy: ['positive-feed', 'progress', 'counters'],
};

const AUTH_OR_PREMIUM_401_PREFIXES = [
  '/api/create-checkout',
  '/api/customer-portal',
  '/api/latest-brief',
  '/api/local-',
  '/api/me/',
  '/api/notification-channels',
  '/api/oauth/',
  '/api/referral/',
  '/api/user/',
  '/api/wm-session',
];

const IGNORABLE_PAGE_ERROR_PATTERNS = [
  /could not compile fragment shader/i,
  /Failed to fetch dynamically imported module/i,
];

const normalizeVariant = (variant: string | undefined): VariantName => {
  if (
    variant === 'tech' ||
    variant === 'finance' ||
    variant === 'commodity' ||
    variant === 'energy' ||
    variant === 'happy'
  ) {
    return variant;
  }
  return 'full';
};

const isExpected401 = (path: string): boolean => {
  if (
    typeof (PREMIUM_RPC_PATHS as { has?: unknown }).has === 'function' &&
    (PREMIUM_RPC_PATHS as Set<string>).has(path)
  ) {
    return true;
  }
  if (Array.isArray(PREMIUM_RPC_PATHS) && PREMIUM_RPC_PATHS.includes(path)) {
    return true;
  }
  return AUTH_OR_PREMIUM_401_PREFIXES.some((prefix) => path.startsWith(prefix));
};

const truncate = (text: string, maxLength = 360): string => {
  const squashed = text.replace(/\s+/g, ' ').trim();
  return squashed.length > maxLength
    ? `${squashed.slice(0, maxLength - 3)}...`
    : squashed;
};

test.describe('variant live reliability smoke', () => {
  test.setTimeout(120_000);

  test('boots the current variant without unexpected public API 401s', async ({
    page,
  }) => {
    const variant = normalizeVariant(process.env.VITE_VARIANT);
    const expectedPanelIds = EXPECTED_BOOT_PANELS[variant];
    const apiResponses: ApiDiagnostic[] = [];
    const apiRequestMetadata = new WeakMap<Request, { method: string; resourceType: string }>();
    const responseCaptureErrors: string[] = [];
    const failedApiRequests: Array<{ failure: string; method: string; path: string; url: string }> = [];
    const pageErrors: string[] = [];
    const consoleIssues: Array<{ text: string; type: string }> = [];

    page.on('request', (request) => {
      const url = request.url();
      if (!isLocalApiUrl(url)) return;
      apiRequestMetadata.set(request, {
        method: request.method(),
        resourceType: request.resourceType(),
      });
    });

    page.on('response', (response) => {
      captureLocalApiResponse(response, apiRequestMetadata, apiResponses, responseCaptureErrors);
    });

    page.on('requestfailed', (request) => {
      const url = request.url();
      if (!isLocalApiUrl(url)) return;
      failedApiRequests.push({
        failure: request.failure()?.errorText ?? 'unknown',
        method: request.method(),
        path: apiPath(url),
        url,
      });
    });

    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });

    page.on('console', (msg) => {
      if (msg.type() !== 'error' && msg.type() !== 'warning') return;
      consoleIssues.push({ type: msg.type(), text: msg.text() });
    });

    await page.goto('/?variantSmoke=1', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toBeVisible();

    await expect
      .poll(async () => page.locator('[data-panel]').count(), { timeout: 60_000 })
      .toBeGreaterThan(1);

    await expect
      .poll(
        async () =>
          page.evaluate((ids) => {
            return ids.filter((id) => document.querySelector(`[data-panel="${CSS.escape(id)}"]`)).length;
          }, expectedPanelIds),
        { timeout: 60_000 }
      )
      .toBeGreaterThan(1);

    await page.waitForTimeout(10_000);
    await assertSignedOutAuthHydrationKeepsHeaderStable(page);

    const panelDiagnostics = await page.evaluate((ids) => {
      const expected = new Set(ids);
      const panelEls = Array.from(document.querySelectorAll<HTMLElement>('[data-panel]'));
      const panels = panelEls.map((panel) => {
        const style = window.getComputedStyle(panel);
        const rect = panel.getBoundingClientRect();
        const visible =
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 0 &&
          rect.height > 0;
        const title =
          panel.querySelector<HTMLElement>('.panel-title, h2, h3')?.textContent?.trim() ?? '';
        const text = panel.textContent ?? '';
        const id = panel.dataset.panel ?? '';
        const locked = Boolean(panel.querySelector('.panel-locked-state')) || panel.classList.contains('panel-is-locked');
        const badgeUnavailable = Boolean(panel.querySelector('.panel-data-badge.unavailable'));
        const error = Boolean(panel.querySelector('.panel-error-state'));
        const loading = Boolean(panel.querySelector('.panel-loading'));
        const newsOrTech =
          /news|headline|tech|ai|github|startup/i.test(id) ||
          /news|headline|technology|ai|github|startup/i.test(title);
        const stale =
          newsOrTech &&
          /\bstale\b|\boutdated\b|digest unavailable|serving stale|no news available/i.test(text);
        return {
          badgeUnavailable,
          error,
          id,
          loading,
          locked,
          stale,
          text,
          title,
          visible,
        };
      });

      const missingExpected = ids.filter(
        (id) => !panels.some((panel) => panel.id === id && panel.visible)
      );
      const panelStates: PanelDiagnostic[] = [];
      for (const panel of panels) {
        if (!panel.visible) continue;
        if (panel.locked) continue;
        if (panel.error) {
          panelStates.push({
            id: panel.id,
            state: 'error',
            text: panel.text,
            title: panel.title,
          });
          continue;
        }
        if (panel.badgeUnavailable) {
          panelStates.push({
            id: panel.id,
            state: 'unavailable',
            text: panel.text,
            title: panel.title,
          });
          continue;
        }
        if (panel.stale) {
          panelStates.push({
            id: panel.id,
            state: 'stale',
            text: panel.text,
            title: panel.title,
          });
          continue;
        }
        if (expected.has(panel.id) && panel.loading) {
          panelStates.push({
            id: panel.id,
            state: 'loading',
            text: panel.text,
            title: panel.title,
          });
        }
      }

      return {
        activeVariant: document.documentElement.dataset.variant || 'full',
        missingExpected,
        panelCount: panels.filter((panel) => panel.visible).length,
        panelStates,
        renderedPanels: panels.filter((panel) => panel.visible).map((panel) => panel.id),
      };
    }, expectedPanelIds);

    const unexpected401 = apiResponses.filter(
      (response) => response.status === 401 && !isExpected401(response.path)
    );
    const unexpectedPageErrors = pageErrors.filter(
      (error) => !IGNORABLE_PAGE_ERROR_PATTERNS.some((pattern) => pattern.test(error))
    );
    // Intentionally NOT asserted on — surfaced only as diagnostics so a
    // live-upstream blip (one provider returning 5xx for a few minutes)
    // doesn't fail this smoke test. The hard assertions below stay focused
    // on app-level signals (variant resolved, no unexpected 401s, no
    // unexpected page errors, expected panels mounted at all).
    const expectedPanelFailures = panelDiagnostics.panelStates.filter(
      (panel) => expectedPanelIds.includes(panel.id) && panel.state !== 'stale'
    );

    const diagnostics = JSON.stringify(
      {
        variant,
        activeVariant: panelDiagnostics.activeVariant,
        unexpected401,
        api401s: apiResponses.filter((response) => response.status === 401),
        responseCaptureErrors: responseCaptureErrors.slice(0, 20),
        failedApiRequests: failedApiRequests.slice(0, 20),
        unexpectedPageErrors,
        consoleIssues: consoleIssues.slice(0, 40),
        missingExpected: panelDiagnostics.missingExpected,
        expectedPanelFailures: expectedPanelFailures.map((panel) => ({
          ...panel,
          text: truncate(panel.text),
        })),
        unavailableOrStalePanels: panelDiagnostics.panelStates.map((panel) => ({
          ...panel,
          text: truncate(panel.text),
        })),
        panelCount: panelDiagnostics.panelCount,
        renderedPanels: panelDiagnostics.renderedPanels,
      },
      null,
      2
    );

    expect(panelDiagnostics.activeVariant, diagnostics).toBe(variant);
    expect(unexpected401, diagnostics).toEqual([]);
    expect(unexpectedPageErrors, diagnostics).toEqual([]);
    expect(panelDiagnostics.missingExpected, diagnostics).toEqual([]);
  });
});
