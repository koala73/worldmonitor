import { expect, test } from '@playwright/test';

function contrast(a: number[], b: number[]): number {
  const luminance = (rgb: number[]) => rgb.map(value => {
    const s = value / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

for (const theme of ['light', 'dark']) for (const standalone of [false, true]) {
  test(`notification text contrast in ${theme} ${standalone ? 'standalone' : 'dashboard'} Settings`, async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 900 });
    await page.addInitScript(themeValue => {
      localStorage.setItem('worldmonitor-theme', themeValue);
      localStorage.setItem('wm-layer-warning-dismissed', 'true');
      localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
      localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
    }, theme);
    await page.route('**/api/**', route => route.fulfill({ json: {} }));
    await page.route('**/src/services/entitlements.ts', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const body = source.replace(/export function hasTier\(minTier\) \{[\s\S]*?\n\}/, 'export function hasTier(minTier) { return true; }');
      expect(body).not.toBe(source);
      await route.fulfill({ response, body });
    });
    await page.goto(standalone ? '/settings.html' : '/dashboard');
    if (standalone) await expect(page.locator('.settings-shell')).toBeVisible();
    else {
      await page.waitForFunction(() => document.documentElement.dataset.wmEventHandlersReady === 'true');
      await page.locator('#unifiedSettingsBtn').click();
      await page.locator('#us-tab-notifications').click();
    }
    await page.evaluate(async ({ channelPath, rendererPath, selector }) => {
      const channels = await import(channelPath);
      channels.__setNotificationChannelsClientDepsForTests({
        getClerkToken: async () => 'controlled-fixture',
        fetch: async () => new Response(JSON.stringify({ channels: [], alertRules: [] }), { headers: { 'Content-Type': 'application/json' } }),
      });
      const { renderNotificationsSettings } = await import(rendererPath);
      const container = document.querySelector(selector)!;
      const rendered = renderNotificationsSettings({ isSignedIn: true });
      container.innerHTML = rendered.html;
      rendered.attach(container);
    }, { channelPath: '/src/services/notification-channels.ts', rendererPath: '/src/services/notifications-settings.ts', selector: standalone ? '#contentArea' : '#us-tab-panel-notifications' });
    const channel = page.locator('.us-notif-ch-row[data-channel-type="telegram"]');
    await expect(channel).toHaveCount(1);
    await expect(channel.locator('.us-notif-ch-name')).toHaveText('Telegram');
    for (const selector of ['.us-notif-ch-name', '.us-notif-ch-sub', '.us-notif-ch-btn-primary']) {
      const colors = await channel.locator(selector).evaluate(el => {
        const rgb = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number);
        return { text: rgb(getComputedStyle(el).color), background: rgb(getComputedStyle(el.closest('.us-notif-ch-row')!).backgroundColor) };
      });
      expect(contrast(colors.text, colors.background), selector).toBeGreaterThanOrEqual(4.5);
    }
    if (standalone) {
      const colors = await page.locator('#contentArea').evaluate(container => {
        const row = document.createElement('div');
        row.className = 'settings-secret-row';
        row.innerHTML = '<select data-model-select><option>Controlled model choice</option></select>';
        container.append(row);
        const style = getComputedStyle(row.querySelector('option')!);
        const rgb = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number);
        return { text: rgb(style.color), background: rgb(style.backgroundColor) };
      });
      expect(contrast(colors.text, colors.background), 'model option').toBeGreaterThanOrEqual(4.5);
    }
  });
}
