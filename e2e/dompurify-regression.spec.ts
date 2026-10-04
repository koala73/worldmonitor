import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/tests/sanitizer-harness', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><body></body></html>',
  }));
  await page.goto('/tests/sanitizer-harness');
});

for (const hook of ['afterSanitizeElements', 'afterSanitizeAttributes'] as const) {
  // GHSA-p98j-92pf-mc4p requires checking the retained descendant, not just the returned root.
  test(`${hook} neutralizes event handlers in a detached subtree`, async ({ page }) => {
    const result = await page.evaluate(async (hookName) => {
      const modulePath = '/node_modules/dompurify/dist/purify.es.mjs';
      const { default: createDOMPurify } = await import(/* @vite-ignore */ modulePath);
      const purify = createDOMPurify(window);
      const root = document.createElement('div');
      root.innerHTML = '<section id="wrap"><img src="x" onerror="ATTACKER()"></section><p>Safe text</p>';
      const wrapper = root.querySelector('section')!;
      const image = root.querySelector('img')!;
      const handlerBefore = image.getAttribute('onerror');
      document.body.append(root);

      try {
        purify.addHook(hookName, (node: Node) => {
          if (node === wrapper) wrapper.remove();
        });
        const sanitized = purify.sanitize(root, { IN_PLACE: true });
        return {
          handlerBefore,
          handlerAfter: image.getAttribute('onerror'),
          sameRoot: sanitized === root,
          detached: !wrapper.isConnected && root.querySelector('section') === null,
          sameDescendant: wrapper.querySelector('img') === image,
          safeText: root.querySelector('p')?.textContent,
        };
      } finally {
        purify.removeAllHooks();
        root.remove();
      }
    }, hook);

    expect(result).toEqual({
      handlerBefore: 'ATTACKER()',
      handlerAfter: null,
      sameRoot: true,
      detached: true,
      sameDescendant: true,
      safeText: 'Safe text',
    });
  });
}

test('widget sanitizer removes hostile markup and preserves supported content', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const modulePath = '/src/utils/widget-sanitizer.ts';
    const { sanitizeWidgetHtml } = await import(/* @vite-ignore */ modulePath);
    const host = document.createElement('div');
    host.innerHTML = sanitizeWidgetHtml(`
      <script>ATTACKER()</script><iframe src="about:blank"></iframe><img src="x" onerror="ATTACKER()">
      <div onclick="ATTACKER()" style="background: url(https://evil.example)"><strong>Safe text</strong></div>
      <span style="color: red">Styled text</span>
      <svg viewBox="0 0 10 10" onload="ATTACKER()"><circle cx="5" cy="5" r="2"></circle></svg>
    `);
    return {
      forbiddenElement: host.querySelector('script, iframe, img') !== null,
      eventHandler: host.querySelector('[onclick], [onerror], [onload]') !== null,
      unsafeStyle: host.querySelector('div')?.hasAttribute('style'),
      safeText: host.querySelector('strong')?.textContent,
      safeStyle: host.querySelector('span')?.getAttribute('style'),
      circleRadius: host.querySelector('circle')?.getAttribute('r'),
    };
  });

  expect(result).toEqual({
    forbiddenElement: false,
    eventHandler: false,
    unsafeStyle: false,
    safeText: 'Safe text',
    safeStyle: 'color: red',
    circleRadius: '2',
  });
});
