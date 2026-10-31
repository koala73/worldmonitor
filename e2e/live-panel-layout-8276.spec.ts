import { expect, test } from '@playwright/test';

test('wide live video panels do not overlap adjacent dashboard panels (#8276)', async ({
  page,
}) => {
  test.setTimeout(120_000);

  await page.addInitScript(() => {
    localStorage.setItem('worldmonitor-variant', 'full');
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem(
      'wm-pro-banner-launched-dismissed',
      String(Date.now()),
    );
  });

  await page.setViewportSize({
    width: 1600,
    height: 866,
  });

  await page.goto('/dashboard', {
    waitUntil: 'domcontentloaded',
  });

  const news = page.locator(
    '#panelsGrid > .panel[data-panel="live-news"]',
  );

  const webcams = page.locator(
    '#panelsGrid > .panel[data-panel="live-webcams"]',
  );

  await expect(news).toHaveCount(1, {
    timeout: 60_000,
  });

  await expect(webcams).toHaveCount(1, {
    timeout: 60_000,
  });

  const cases = [
    { height: 590, span: 2, panelHeight: 404 },
    { height: 671, span: 2, panelHeight: 404 },
    { height: 672, span: 3, panelHeight: 608 },
    { height: 866, span: 3, panelHeight: 608 },
  ];

  for (const viewport of cases) {
    await page.setViewportSize({
      width: 1600,
      height: viewport.height,
    });
    await expect.poll(
      async () => page.evaluate(({ span, panelHeight }) => {
        const grid = document.querySelector('#panelsGrid');

        if (!grid) return false;

        const panels = Array.from(
          grid.querySelectorAll<HTMLElement>(':scope > .panel'),
        ).filter(
          panel => getComputedStyle(panel).display !== 'none',
        );

        const ids = ['live-news', 'live-webcams'];

        return ids.every(id => {
          const panel = panels.find(
            candidate => candidate.dataset.panel === id,
          );

          if (!panel) return false;

          const rect = panel.getBoundingClientRect();
          const style = getComputedStyle(panel);

          const next = panels
            .filter(candidate => candidate !== panel)
            .map(candidate => ({
              panel: candidate,
              rect: candidate.getBoundingClientRect(),
            }))
            .filter(candidate => {
              const horizontalOverlap =
                Math.min(rect.right, candidate.rect.right) -
                Math.max(rect.left, candidate.rect.left);

              return (
                horizontalOverlap > 20 &&
                candidate.rect.top > rect.top + 5
              );
            })
            .sort(
              (a, b) => a.rect.top - b.rect.top,
            )[0];

          if (!next) return false;

          const gap = next.rect.top - rect.bottom;

          return (
            style.gridRowStart === `span ${span}` &&
            Math.abs(rect.height - panelHeight) <= 2 &&
            Math.abs(gap - 4) <= 2 &&
            !panel.classList.contains('resized')
          );
        });
      }, viewport),
      {
        message:
          `Video panel layout at 1600x${viewport.height}`,
        timeout: 30_000,
      },
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1600, height: 866 });
  for (const panel of [news, webcams]) {
    await panel.locator('.panel-collapse-btn').click();
    await expect(panel).toHaveClass(/panel-collapsed/);
    await expect.poll(() => panel.evaluate(element => getComputedStyle(element).gridRowStart)).toBe('span 2');
  }
});
