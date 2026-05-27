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
    .poll(async () => (await panelIds(page, gridSelector)).length, { timeout: 60_000 })
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

async function dragPanelToPoint(page: Page, sourceId: string, x: number, y: number): Promise<void> {
  const sourceHeader = page.locator(`${panelSelector(sourceId)} > .panel-header`).first();
  await sourceHeader.scrollIntoViewIfNeeded();
  const sourceBox = await boundingBoxOrThrow(sourceHeader, `source panel ${sourceId}`);
  const startX = sourceBox.x + Math.min(48, sourceBox.width / 2);
  const startY = sourceBox.y + sourceBox.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 12, startY + 12, { steps: 3 });
  await page.mouse.move(x, y, { steps: 12 });
  await nextAnimationFrame(page);
  await page.mouse.up();
}

async function dragPanelToPanel(
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
  await dragPanelToPoint(page, sourceId, targetX, targetY);
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

  test('Escape cancels an in-progress drag without persisting order', async ({ page }) => {
    await loadHappyDashboard(page);
    const before = await panelIds(page);
    const [sourceId, , , targetId] = before;
    expect(sourceId && targetId).toBeTruthy();
    const storedBefore = await page.evaluate(() => localStorage.getItem('panel-order'));

    const target = page.locator(panelSelector(targetId!)).first();
    await target.scrollIntoViewIfNeeded();
    const targetBox = await boundingBoxOrThrow(target, `target panel ${targetId}`);
    const sourceHeader = page.locator(`${panelSelector(sourceId!)} > .panel-header`).first();
    const sourceBox = await boundingBoxOrThrow(sourceHeader, `source panel ${sourceId}`);
    const startX = sourceBox.x + Math.min(48, sourceBox.width / 2);
    const startY = sourceBox.y + sourceBox.height / 2;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 12, startY + 12, { steps: 3 });
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height * 0.75, { steps: 12 });
    await nextAnimationFrame(page);
    await page.keyboard.press('Escape');
    await page.mouse.up();

    await expect.poll(async () => await panelIds(page)).toEqual(before);
    expect(await page.evaluate(() => localStorage.getItem('panel-order'))).toBe(storedBefore);
  });
});
