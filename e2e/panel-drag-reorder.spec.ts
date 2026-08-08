import { expect, test, type Locator, type Page } from '@playwright/test';

const DASHBOARD_VIEWPORT = { width: 1700, height: 900 };

async function loadHappyDashboard(page: Page): Promise<void> {
  await page.setViewportSize(DASHBOARD_VIEWPORT);
  await page.addInitScript(() => {
    if (sessionStorage.getItem('__panel_drag_reorder_init_done')) return;
    localStorage.clear();
    localStorage.setItem('worldmonitor-variant', 'happy');
    sessionStorage.setItem('__panel_drag_reorder_init_done', '1');
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForPanelCount(page, 4);
}

async function waitForPanelCount(page: Page, minCount: number, gridSelector = '#panelsGrid'): Promise<void> {
  await expect
    .poll(
      async () => {
        const before = await panelIds(page, gridSelector);
        await page.waitForTimeout(250);
        const after = await panelIds(page, gridSelector);
        return before.length >= minCount && before.join('\0') === after.join('\0') ? after.length : 0;
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThanOrEqual(minCount);
}

async function panelIds(page: Page, gridSelector = '#panelsGrid'): Promise<string[]> {
  return page.locator(`${gridSelector} > .panel[data-panel]:not(.hidden)`).evaluateAll((els) =>
    els
      .map((el) => (el as HTMLElement).dataset.panel)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
}

function panelSelector(id: string): string {
  return `.panel[data-panel="${id}"]`;
}

async function boundingBoxOrThrow(locator: Locator, label: string) {
  const box = await locator.boundingBox();
  expect(box, `${label} should have a rendered bounding box`).not.toBeNull();
  return box!;
}

async function nextAnimationFrame(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

async function beginDragToPoint(page: Page, sourceId: string, x: number, y: number): Promise<void> {
  const sourceHeader = page.locator(`${panelSelector(sourceId)} > .panel-header`).first();
  await expect(sourceHeader).toBeVisible();
  const sourceBox = await boundingBoxOrThrow(sourceHeader, `source panel ${sourceId}`);
  const startX = sourceBox.x + Math.min(48, sourceBox.width / 2);
  const startY = sourceBox.y + sourceBox.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 12, startY + 12, { steps: 3 });
  await page.mouse.move(x, y, { steps: 12 });
  await nextAnimationFrame(page);
}

async function releaseDrag(page: Page): Promise<void> {
  await page.mouse.up();
}

async function dragPanelToPoint(page: Page, sourceId: string, x: number, y: number): Promise<void> {
  await beginDragToPoint(page, sourceId, x, y);
  await releaseDrag(page);
}

async function dragPanelBelowThreshold(page: Page, sourceId: string): Promise<void> {
  const sourceHeader = page.locator(`${panelSelector(sourceId)} > .panel-header`).first();
  await sourceHeader.scrollIntoViewIfNeeded();
  const sourceBox = await boundingBoxOrThrow(sourceHeader, `source panel ${sourceId}`);
  const startX = sourceBox.x + Math.min(48, sourceBox.width / 2);
  const startY = sourceBox.y + sourceBox.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 4, startY + 4);
  await page.mouse.up();
}

async function beginDragToPanel(
  page: Page,
  sourceId: string,
  targetId: string,
  position: 'upper' | 'lower',
): Promise<void> {
  const target = page.locator(panelSelector(targetId)).first();
  await target.scrollIntoViewIfNeeded();
  const targetBox = await boundingBoxOrThrow(target, `target panel ${targetId}`);
  const targetX = targetBox.x + targetBox.width / 2;
  const targetY = targetBox.y + targetBox.height * (position === 'upper' ? 0.25 : 0.75);
  await beginDragToPoint(page, sourceId, targetX, targetY);
}

async function dragPanelToPanel(
  page: Page,
  sourceId: string,
  targetId: string,
  position: 'upper' | 'lower',
): Promise<void> {
  await beginDragToPanel(page, sourceId, targetId, position);
  await releaseDrag(page);
}

async function sameGridGapPoint(page: Page, sourceId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((id) => {
    const grid = document.querySelector<HTMLElement>('#panelsGrid');
    const source = document.querySelector<HTMLElement>(`.panel[data-panel="${CSS.escape(id)}"]`);
    if (!grid || !source) throw new Error('Missing panels grid or source panel');

    const gridRect = grid.getBoundingClientRect();
    const sourceRect = source.getBoundingClientRect();
    const panelRects = Array.from(grid.querySelectorAll<HTMLElement>(':scope > .panel[data-panel]:not(.hidden)'))
      .filter((panel) => panel !== source)
      .map((panel) => panel.getBoundingClientRect());
    if (panelRects.length === 0) throw new Error('Need another panel to find an interior grid gap');

    const maxPanelBottom = Math.max(...panelRects.map((rect) => rect.bottom));
    for (let y = Math.ceil(sourceRect.bottom) + 1; y < Math.floor(maxPanelBottom) - 1; y += 2) {
      for (let x = Math.ceil(gridRect.left) + 2; x < Math.floor(gridRect.right) - 2; x += 8) {
        const hit = document.elementFromPoint(x, y);
        if (!(hit instanceof HTMLElement)) continue;
        if (hit.closest('.panel') || hit.closest('.add-panel-block')) continue;
        if (hit === grid || hit.closest('#panelsGrid') === grid) return { x, y };
      }
    }

    throw new Error('No same-grid interior gap point found');
  }, sourceId);
}

async function storedPanelOrder(page: Page): Promise<string[]> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('panel-order') || '[]') as string[]);
}

async function storedBottomSet(page: Page): Promise<string[]> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('panel-order-bottom-set') || '[]') as string[]);
}

test.describe('panel drag reorder semantics', () => {
  test('moves a panel after the indicated same-grid target instead of swapping', async ({ page }) => {
    await loadHappyDashboard(page);
    const before = await panelIds(page);
    const [first, second, third, fourth] = before;
    expect(first && second && third && fourth).toBeTruthy();

    await dragPanelToPanel(page, first!, fourth!, 'lower');

    const expectedPrefix = [second, third, fourth, first];
    await expect.poll(async () => (await panelIds(page)).slice(0, 4)).toEqual(expectedPrefix);
    expect((await panelIds(page)).slice(0, 4)).not.toEqual([fourth, second, third, first]);
    expect((await storedPanelOrder(page)).slice(0, 4)).toEqual(expectedPrefix);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForPanelCount(page, 4);
    await expect.poll(async () => (await panelIds(page)).slice(0, 4)).toEqual(expectedPrefix);
  });

  test('moves a panel before the indicated same-grid target', async ({ page }) => {
    await loadHappyDashboard(page);
    const before = await panelIds(page);
    const [first, second, third, fourth] = before;
    expect(first && second && third && fourth).toBeTruthy();

    await dragPanelToPanel(page, fourth!, second!, 'upper');

    const expectedPrefix = [first, fourth, second, third];
    await expect.poll(async () => (await panelIds(page)).slice(0, 4)).toEqual(expectedPrefix);
    expect((await storedPanelOrder(page)).slice(0, 4)).toEqual(expectedPrefix);
  });

  test('same-grid interior gap drops do not jump the panel to the end', async ({ page }) => {
    await loadHappyDashboard(page);
    const before = await panelIds(page);
    const [sourceId] = before;
    expect(sourceId).toBeTruthy();
    const storedBefore = await page.evaluate(() => localStorage.getItem('panel-order'));
    const gap = await sameGridGapPoint(page, sourceId!);

    await dragPanelToPoint(page, sourceId!, gap.x, gap.y);

    await expect.poll(async () => await panelIds(page)).toEqual(before);
    expect(await page.evaluate(() => localStorage.getItem('panel-order'))).toBe(storedBefore);
  });

  test('moves a panel into empty bottom-grid space and restores it after reload', async ({ page }) => {
    await loadHappyDashboard(page);
    const [sourceId] = await panelIds(page);
    expect(sourceId).toBeTruthy();

    const bottomGrid = page.locator('#mapBottomGrid');
    const bottomBox = await boundingBoxOrThrow(bottomGrid, 'bottom grid');
    expect(bottomBox.height).toBeGreaterThan(20);

    await dragPanelToPoint(page, sourceId!, bottomBox.x + bottomBox.width / 2, bottomBox.y + bottomBox.height / 2);

    await expect(page.locator(`#mapBottomGrid > ${panelSelector(sourceId!)}`)).toHaveCount(1);
    await expect(page.locator(`#panelsGrid > ${panelSelector(sourceId!)}`)).toHaveCount(0);
    expect(await storedBottomSet(page)).toContain(sourceId);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForPanelCount(page, 3);
    await expect(page.locator(`#mapBottomGrid > ${panelSelector(sourceId!)}`)).toHaveCount(1);
    expect(await storedBottomSet(page)).toContain(sourceId);
  });

  test('sub-threshold mouse movement does not start a drag or persist order', async ({ page }) => {
    await loadHappyDashboard(page);
    const before = await panelIds(page);
    const [sourceId] = before;
    expect(sourceId).toBeTruthy();
    const storedBefore = await page.evaluate(() => localStorage.getItem('panel-order'));

    await dragPanelBelowThreshold(page, sourceId!);

    expect(await panelIds(page)).toEqual(before);
    expect(await page.evaluate(() => localStorage.getItem('panel-order'))).toBe(storedBefore);
  });

  test('Escape cancels an in-progress drag without persisting order', async ({ page }) => {
    await loadHappyDashboard(page);
    const before = await panelIds(page);
    const [sourceId, , , targetId] = before;
    expect(sourceId && targetId).toBeTruthy();
    const storedBefore = await page.evaluate(() => localStorage.getItem('panel-order'));

    await beginDragToPanel(page, sourceId!, targetId!, 'lower');
    await page.keyboard.press('Escape');
    await releaseDrag(page);

    await expect.poll(async () => await panelIds(page)).toEqual(before);
    expect(await page.evaluate(() => localStorage.getItem('panel-order'))).toBe(storedBefore);
  });
});
