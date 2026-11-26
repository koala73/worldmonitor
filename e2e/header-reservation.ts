import { expect, type Page } from '@playwright/test';

export const HEADER_AUTH_SLOT_WIDTH = 200;

type Box = {
  height: number;
  width: number;
  x: number;
  y: number;
};

const waitForLayoutFrame = async (page: Page): Promise<void> => {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
};

const expectBoxesToMatch = (actual: Box, expected: Box, message: string): void => {
  expect(Math.abs(actual.x - expected.x), `${message} x`).toBeLessThanOrEqual(1);
  expect(Math.abs(actual.y - expected.y), `${message} y`).toBeLessThanOrEqual(1);
  expect(Math.abs(actual.width - expected.width), `${message} width`).toBeLessThanOrEqual(1);
  expect(Math.abs(actual.height - expected.height), `${message} height`).toBeLessThanOrEqual(1);
};

export const assertSignedOutAuthHydrationKeepsHeaderStable = async (page: Page): Promise<void> => {
  await page.locator('.header').waitFor();
  const result = await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>('.header');
    const authMount = document.getElementById('authWidgetMount');
    if (!header || !authMount) {
      throw new Error('missing header auth reservation elements');
    }

    const rectOf = (element: Element): Box => {
      const rect = element.getBoundingClientRect();
      return {
        height: rect.height,
        width: rect.width,
        x: rect.x,
        y: rect.y,
      };
    };

    const beforeHeaderBox = rectOf(header);
    const beforeAuthMountBox = rectOf(authMount);
    const pendingSkeletonCount = authMount.querySelectorAll('.auth-header-skeleton').length;

    const widget = document.createElement('div');
    widget.className = 'auth-header-widget';

    const freeReason = document.createElement('span');
    freeReason.className = 'auth-free-reason';
    freeReason.textContent = 'Free: save your layout, follow countries, get alerts';
    widget.appendChild(freeReason);

    const signInButton = document.createElement('button');
    signInButton.className = 'auth-signin-btn';
    signInButton.type = 'button';
    signInButton.textContent = 'Sign In';
    widget.appendChild(signInButton);

    authMount.replaceChildren(widget);

    return {
      beforeAuthMountBox,
      beforeHeaderBox,
      pendingSkeletonCount,
    };
  });

  await waitForLayoutFrame(page);

  const hydrated = await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>('.header');
    const authMount = document.getElementById('authWidgetMount');
    const widget = authMount?.querySelector<HTMLElement>('.auth-header-widget');
    if (!header || !authMount || !widget) {
      throw new Error('missing hydrated header auth elements');
    }

    const rectOf = (element: Element): Box => {
      const rect = element.getBoundingClientRect();
      return {
        height: rect.height,
        width: rect.width,
        x: rect.x,
        y: rect.y,
      };
    };

    return {
      afterAuthMountBox: rectOf(authMount),
      afterHeaderBox: rectOf(header),
      hydratedWidgetBox: rectOf(widget),
      authMountMinWidth: getComputedStyle(authMount).minWidth,
      hasCreateAccount: Boolean(widget.querySelector('.auth-signup-link')),
      hasFreeReason: Boolean(widget.querySelector('.auth-free-reason')),
      signInCount: widget.querySelectorAll('.auth-signin-btn').length,
    };
  });

  expect(hydrated.authMountMinWidth).toBe('72px');
  expect(result.beforeAuthMountBox.width).toBeGreaterThanOrEqual(72);
  expect(result.beforeAuthMountBox.width).toBeLessThanOrEqual(HEADER_AUTH_SLOT_WIDTH + 1);
  expect(hydrated.afterAuthMountBox.width).toBeGreaterThanOrEqual(72);
  expect(hydrated.afterAuthMountBox.width).toBeLessThanOrEqual(HEADER_AUTH_SLOT_WIDTH + 1);
  expect(hydrated.hydratedWidgetBox.width).toBeGreaterThan(70);
  expect(hydrated.hydratedWidgetBox.width).toBeLessThanOrEqual(HEADER_AUTH_SLOT_WIDTH + 1);
  expect(hydrated.hasCreateAccount).toBe(false);
  expect(hydrated.hasFreeReason).toBe(true);
  expect(hydrated.signInCount).toBe(1);
  if (result.pendingSkeletonCount > 0) {
    expect(result.pendingSkeletonCount).toBe(2);
  }
  expectBoxesToMatch(hydrated.afterAuthMountBox, result.beforeAuthMountBox, 'auth mount');
  expectBoxesToMatch(hydrated.afterHeaderBox, result.beforeHeaderBox, 'header');
};
