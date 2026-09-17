import { expect, test } from '@playwright/test';

test('investment search keeps its live input and caret through result updates', async ({ page }) => {
  await page.goto('/tests/runtime-harness.html');
  await page.evaluate(async () => {
    const path = '/src/components/InvestmentsPanel.ts';
    const { InvestmentsPanel } = await import(/* @vite-ignore */ path);
    const panel = new InvestmentsPanel();
    document.body.replaceChildren(panel.getElement());
  });
  const search = page.locator('.fdi-search');
  await search.fill('port');
  await search.evaluate((input: HTMLInputElement) => { input.dataset.original = 'true'; input.setSelectionRange(1, 3); });
  // Wait beyond the base Panel debounce: the input must survive the commit.
  await page.waitForTimeout(250);
  await expect(search).toBeFocused();
  await expect(search).toHaveAttribute('data-original', 'true');
  expect(await search.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([1, 3]);
  await search.fill('no-such-investment-zzzz');
  await expect(page.locator('.fdi-row')).toHaveCount(0);
  await expect(page.locator('.fdi-empty')).toBeVisible();
  await search.fill('');
  await expect(page.locator('.fdi-row').first()).toBeVisible();
  await expect(search).toBeFocused();
});
