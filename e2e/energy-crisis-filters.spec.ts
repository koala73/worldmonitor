import { expect, test } from '@playwright/test';

test('energy filters survive the first debounced render and repeated replacements', async ({ page }) => {
  await page.route('**/api/economic/v1/get-energy-crisis-policies*', route => route.fulfill({
    json: { policies: [
      { country: 'Japan', countryCode: 'JP', category: 'conservation', sector: 'transport', status: 'active', measure: 'Conserve fuel', dateAnnounced: '2026-09-01' },
      { country: 'France', countryCode: 'FR', category: 'consumer_support', sector: 'general', status: 'active', measure: 'Support households', dateAnnounced: '2026-09-02' },
    ], updatedAt: '2026-09-16T00:00:00Z', sourceUrl: 'https://www.iea.org/' },
  }));
  await page.goto('/tests/runtime-harness.html');
  await page.evaluate(async () => {
    // Vite loads the production class and its real debounced Panel base.
    const path = '/src/components/EnergyCrisisPanel.ts';
    const { EnergyCrisisPanel } = await import(/* @vite-ignore */ path);
    const panel = new EnergyCrisisPanel();
    document.body.replaceChildren(panel.getElement());
    await panel.fetchData();
  });
  const rows = page.locator('.ecp-policy-row');
  await expect(rows).toHaveCount(2);
  await page.getByRole('button', { name: 'Conservation', exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Conserve fuel');
  await page.getByRole('button', { name: 'Consumer Support', exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Support households');
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(rows).toHaveCount(2);
});
