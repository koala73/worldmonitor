import { expect, test, type Frame, type Page } from '@playwright/test';

type SandboxProbeWindow = Window & typeof globalThis & {
  __bodyBeforeUnloadCalls: number;
  __clickCalls: number;
  __framesetBeforeUnloadCalls: number;
};

async function mountSandboxWidget(page: Page, id: string, html: string): Promise<Frame> {
  const token = `token-${id}`;

  await page.evaluate(({ html: widgetHtml, id: widgetId, token: widgetToken }) => {
    const iframe = document.createElement('iframe');
    iframe.dataset.testid = widgetId;
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.src = `/wm-widget-sandbox.html#id=${encodeURIComponent(widgetId)}&token=${encodeURIComponent(widgetToken)}`;

    function handleReady(event: MessageEvent): void {
      if (
        event.source !== iframe.contentWindow
        || !event.data
        || event.data.type !== 'wm-widget-ready'
        || event.data.id !== widgetId
        || event.data.token !== widgetToken
      ) {
        return;
      }

      document.documentElement.dataset.widgetReady = widgetId;
      iframe.contentWindow?.postMessage(
        { type: 'wm-html', id: widgetId, token: widgetToken, html: widgetHtml },
        '*',
      );
      window.removeEventListener('message', handleReady);
    }

    window.addEventListener('message', handleReady);
    document.body.appendChild(iframe);
  }, { html, id, token });

  const iframe = page.locator(`iframe[data-testid="${id}"]`);
  await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
  await expect.poll(
    () => page.evaluate(() => document.documentElement.dataset.widgetReady),
  ).toBe(id);

  const handle = await iframe.elementHandle();
  const frame = await handle?.contentFrame();
  expect(frame).not.toBeNull();
  return frame!;
}

test.describe('PRO widget sandbox', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/widget-sandbox-parent', (route) => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body></body></html>',
    }));
    await page.goto('/widget-sandbox-parent');
  });

  test('stops reflected body and frameset beforeunload handlers after document.open', async ({ page }) => {
    const bodyFrame = await mountSandboxWidget(page, 'body-widget', `<!doctype html>
<html>
<body onbeforeunload="window.__bodyBeforeUnloadCalls += 1">
  <script>
    window.__bodyBeforeUnloadCalls = 0;
    window.__clickCalls = 0;

    window.addEventListener('click', function () { window.__clickCalls += 1; });
    window.dispatchEvent(new Event('beforeunload'));
    window.dispatchEvent(new Event('click'));
    document.body.dataset.widgetReady = 'true';
  </script>
</body>
</html>`);

    await expect.poll(
      () => bodyFrame.evaluate(() => document.body?.dataset.widgetReady),
    ).toBe('true');

    expect(await bodyFrame.evaluate(() => {
      const probe = window as SandboxProbeWindow;
      return {
        body: probe.__bodyBeforeUnloadCalls,
        click: probe.__clickCalls,
      };
    })).toEqual({ body: 0, click: 1 });

    await bodyFrame.evaluate(() => window.dispatchEvent(new Event('beforeunload')));
    expect(await bodyFrame.evaluate(() => {
      const probe = window as SandboxProbeWindow;
      return probe.__bodyBeforeUnloadCalls;
    })).toBe(0);

    const framesetFrame = await mountSandboxWidget(page, 'frameset-widget', `<!doctype html>
<html>
<head><script>window.__framesetBeforeUnloadCalls = 0;</script></head>
<frameset onbeforeunload="window.__framesetBeforeUnloadCalls += 1">
  <frame src="about:blank">
</frameset>
</html>`);

    await expect.poll(
      () => framesetFrame.evaluate(() => Boolean(document.querySelector('frameset'))),
    ).toBe(true);
    await framesetFrame.evaluate(() => window.dispatchEvent(new Event('beforeunload')));
    expect(
      await framesetFrame.evaluate(
        () => (window as SandboxProbeWindow).__framesetBeforeUnloadCalls,
      ),
    ).toBe(0);
  });
});
