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

          // Every desktop webcam cell must fit inside the webcam grid; a
          // height cap that clips the 2x2 grid would otherwise still pass.
          const webcamGrid = id === 'live-webcams'
            ? panel.querySelector<HTMLElement>('.webcam-grid')
            : null;
          const gridRect = webcamGrid?.getBoundingClientRect();
          const webcamCells = webcamGrid
            ? Array.from(webcamGrid.querySelectorAll<HTMLElement>('.webcam-cell'))
            : [];
          const webcamCellsVisible = id !== 'live-webcams' || (
            !!gridRect &&
            webcamCells.length === 4 &&
            webcamCells.every(cell => {
              const cellRect = cell.getBoundingClientRect();
              return (
                getComputedStyle(cell).display !== 'none' &&
                cellRect.height > 0 &&
                cellRect.top >= gridRect.top - 2 &&
                cellRect.bottom <= gridRect.bottom + 2
              );
            })
          );

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
            webcamCellsVisible &&
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
  const footprint = (panel: typeof news) => panel.evaluate(element => ({
    span: getComputedStyle(element).gridRowStart,
    height: Math.round(element.getBoundingClientRect().height),
  }));
  // A user can enable every optional channel (85); the wrapped channel bar
  // must not push a collapsed panel past its one grid row.
  await news.evaluate((element) => {
    const switcher = element.querySelector('.live-news-switcher')!;
    const buttons = Array.from(switcher.querySelectorAll('.live-channel-btn'));
    for (let i = 0; switcher.querySelectorAll('.live-channel-btn').length < 85; i++) {
      const clone = buttons[i % buttons.length]!.cloneNode(true) as HTMLElement;
      clone.classList.remove('active');
      switcher.appendChild(clone);
    }
  });
  // A collapsed video panel is only a header, so it reserves one grid row
  // instead of the two-row .panel-wide footprint.
  for (const panel of [news, webcams]) {
    await panel.locator('.panel-collapse-btn').click();
    await expect(panel).toHaveClass(/panel-collapsed/);
    await expect.poll(() => footprint(panel)).toMatchObject({ span: 'span 1' });
    expect((await footprint(panel)).height).toBeLessThanOrEqual(200);
  }
  const collapsedOverlap = await page.evaluate(() => {
    const rect = (id: string) => document
      .querySelector(`#panelsGrid > .panel[data-panel="${id}"]`)!
      .getBoundingClientRect();
    return Math.round(rect('live-news').bottom - rect('live-webcams').top);
  });
  expect(collapsedOverlap).toBeLessThanOrEqual(0);
  for (const panel of [news, webcams]) {
    await panel.locator('.panel-collapse-btn').click();
    await expect(panel).not.toHaveClass(/panel-collapsed/);
    await expect.poll(() => footprint(panel)).toEqual({ span: 'span 3', height: 608 });
  }
});
