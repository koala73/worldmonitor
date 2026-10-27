import { expect, test, type Frame, type Page } from '@playwright/test';

type SandboxProbeWindow = Window & typeof globalThis & {
  __bodyBeforeUnloadCalls: number;
  __clickCalls: number;
  __framesetBeforeUnloadCalls: number;
  __widgetScriptRan: boolean;
};

async function mountSandboxWidget(
  page: Page,
  id: string,
  html: string,
  { iframeSandbox = true }: { iframeSandbox?: boolean } = {},
): Promise<Frame> {
  const token = `token-${id}`;

  await page.evaluate(({ html: widgetHtml, id: widgetId, token: widgetToken, iframeSandbox: useIframeSandbox }) => {
    const iframe = document.createElement('iframe');
    iframe.dataset.testid = widgetId;
    if (useIframeSandbox) iframe.setAttribute('sandbox', 'allow-scripts');
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
  }, { html, id, token, iframeSandbox });

  const iframe = page.locator(`iframe[data-testid="${id}"]`);
  if (iframeSandbox) await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
  await expect.poll(
    () => page.evaluate(() => document.documentElement.dataset.widgetReady),
  ).toBe(id);

  const handle = await iframe.elementHandle();
  const frame = await handle?.contentFrame();
  expect(frame).not.toBeNull();
  return frame!;
}

const SANDBOX_CSP = "default-src 'none'; sandbox allow-scripts; script-src 'unsafe-inline' https://cdn.jsdelivr.net https://static.cloudflareinsights.com; style-src 'unsafe-inline'; img-src data:; connect-src https://cdn.jsdelivr.net;";

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

  test('enforces the response sandbox when the iframe has no sandbox attribute', async ({ page }) => {
    const responsePromise = page.waitForResponse(response => response.url().includes('/wm-widget-sandbox.html'));

    const frame = await mountSandboxWidget(page, 'response-sandbox-widget', `<!doctype html>
<script>
  window.__widgetScriptRan = true;
</script>`, { iframeSandbox: false });

    const iframe = page.locator('iframe[data-testid="response-sandbox-widget"]');
    await expect(iframe).not.toHaveAttribute('sandbox', /.+/);
    await expect.poll(
      () => frame.evaluate(() => (window as SandboxProbeWindow).__widgetScriptRan),
    ).toBe(true);
    expect(await frame.evaluate(() => window.origin)).toBe('null');
    expect((await responsePromise).headers()['content-security-policy']).toBe(SANDBOX_CSP);
  });

  test('renders a same-origin widget and blocks a different loopback parent origin', async ({ page }, testInfo) => {
    await page.evaluate(() => {
      document.body.innerHTML = '<style>body{font:18px system-ui;padding:24px}iframe{width:700px;height:240px;display:block;margin:20px 0}</style><h1>Widget sandbox security check</h1><p>Controlled local fixture. Same-origin widget below.</p>';
    });
    const frame = await mountSandboxWidget(page, 'visible-widget', `<!doctype html><body style="font:20px system-ui;background:#142130;color:white;padding:20px"><h2>WorldMonitor widget</h2><p id="rendered">Same-origin render passed</p><script>try { parent.document.body.dataset.compromised = 'true'; } catch { document.body.dataset.isolated = 'true'; }</script></body>`, { iframeSandbox: false });
    await expect(frame.locator('#rendered')).toBeVisible();
    expect(await frame.evaluate(() => document.body.dataset.isolated)).toBe('true');
    expect(await page.evaluate(() => document.body.dataset.compromised)).toBeUndefined();
    await page.screenshot({ path: testInfo.outputPath('widget-sandbox-normal.png') });
    const sandboxUrl = new URL('/wm-widget-sandbox.html#id=foreign&token=foreign-token', page.url());
    const foreignParent = new URL('/widget-sandbox-parent', page.url());
    foreignParent.hostname = 'localhost';
    await page.context().grantPermissions(['local-network-access'], { origin: foreignParent.origin });
    await page.goto(foreignParent.href);
    await page.evaluate(() => {
      document.body.innerHTML = '<style>body{font:18px system-ui;padding:24px}iframe{width:700px;height:240px;display:block;margin:20px 0}</style><h1>Widget sandbox security check</h1><p>Controlled local fixture. Parent and sandbox have different loopback origins.</p>';
    });
    const foreignResponse = page.waitForResponse(response => response.url().includes('/wm-widget-sandbox.html'));
    await page.evaluate(async url => {
      const iframe = document.createElement('iframe');
      iframe.dataset.testid = 'foreign';
      iframe.src = url;
      document.body.appendChild(iframe);
      await new Promise(resolve => { iframe.onload = () => resolve(null); });
      iframe.contentWindow!.postMessage({ type: 'wm-html', id: 'foreign', token: 'foreign-token', html: '<body id="attack">ATTACK RENDERED</body>' }, '*');
    }, sandboxUrl.href);
    expect((await foreignResponse).status()).toBe(200);
    const foreign = page.frames().find(candidate => candidate.url().includes('#id=foreign'))!;
    await foreign.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(foreign.locator('#attack')).toHaveCount(0);
    await page.evaluate(() => {
      document.body.insertAdjacentHTML('beforeend', '<p>Different loopback parent origin: HTML delivery blocked.</p>');
    });
    await page.screenshot({ path: testInfo.outputPath('widget-sandbox-blocked.png') });
  });
});
