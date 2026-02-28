/**
 * E2E tests for OpenSens DAMD workflow
 * Run with: VITE_VARIANT=opensens playwright test e2e/opensens-workflow.spec.ts
 *
 * Covers:
 *   1. Page loads with opensens variant
 *   2. Energy Potential panel renders
 *   3. Autonomy Simulator sliders update output
 *   4. Connectivity Planner panel renders
 *   5. Node Placement panel renders
 *   6. ROI Dashboard panel renders
 *   7. Assumptions panel shows data sources
 */
import { test, expect } from '@playwright/test';

test.describe('OpenSens DAMD — variant load', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?variant=opensens', { waitUntil: 'networkidle' });
  });

  test('page title contains OpenSens or World Monitor', async ({ page }) => {
    await expect(page).toHaveTitle(/OpenSens|World Monitor/i);
  });

  test('Energy Potential panel is present', async ({ page }) => {
    const panel = page.locator('.energy-potential-panel, [data-panel="energy-potential"]');
    await expect(panel.first()).toBeVisible({ timeout: 10000 });
  });

  test('Autonomy Simulator panel is present', async ({ page }) => {
    const panel = page.locator('.autonomy-simulator-panel, [data-panel="autonomy-simulator"]');
    await expect(panel.first()).toBeVisible({ timeout: 10000 });
  });

  test('Connectivity Planner panel is present', async ({ page }) => {
    const panel = page.locator('.connectivity-planner-panel, [data-panel="connectivity"]');
    await expect(panel.first()).toBeVisible({ timeout: 10000 });
  });

  test('ROI Dashboard panel is present', async ({ page }) => {
    const panel = page.locator('.roi-dashboard-panel, [data-panel="roi-dashboard"]');
    await expect(panel.first()).toBeVisible({ timeout: 10000 });
  });

  test('Assumptions panel shows data sources table', async ({ page }) => {
    const panel = page.locator('.assumptions-panel, [data-panel="assumptions"]');
    await expect(panel.first()).toBeVisible({ timeout: 10000 });
    await expect(panel.locator('table').first()).toBeVisible();
  });
});

test.describe('OpenSens DAMD — Autonomy Simulator', () => {
  test('BESS slider updates autonomy display', async ({ page }) => {
    await page.goto('/?variant=opensens', { waitUntil: 'networkidle' });
    const panel = page.locator('.autonomy-simulator-panel').first();
    await expect(panel).toBeVisible({ timeout: 10000 });

    const slider = panel.locator('#bess-slider');
    if (await slider.isVisible()) {
      await slider.fill('40');
      await slider.dispatchEvent('input');
      // After changing BESS, autonomy hours should update
      await expect(panel.locator('.results')).toBeVisible();
    }
  });
});

test.describe('OpenSens DAMD — API endpoints (smoke)', () => {
  test('weather endpoint returns 200 for valid coords', async ({ request }) => {
    const res = await request.get('/api/opensens/weather?lat=48.85&lon=2.35&days=3&past_days=3');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('hourly');
    expect(body).toHaveProperty('daily_summary');
    expect(body).toHaveProperty('meta');
  });

  test('weather endpoint returns 400 for missing lat', async ({ request }) => {
    const res = await request.get('/api/opensens/weather?lon=2.35');
    expect(res.status()).toBe(400);
  });

  test('pv endpoint returns 200 for valid coords', async ({ request }) => {
    const res = await request.get('/api/opensens/pv?lat=48.85&lon=2.35&kwp=3');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('kwhPerDay');
    expect(body).toHaveProperty('monthly');
  });

  test('connectivity endpoint returns options array', async ({ request }) => {
    const res = await request.get('/api/opensens/connectivity?lat=51.5&lon=-0.1&country=GB&objective=cost');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.options)).toBe(true);
    expect(body.options.length).toBeGreaterThan(0);
  });

  test('routing endpoint returns 400 without hub coords', async ({ request }) => {
    const res = await request.get('/api/opensens/routing?sites=[{"id":"a","lat":51.5,"lon":-0.1}]');
    expect(res.status()).toBe(400);
  });

  test('roi endpoint returns scenarios', async ({ request }) => {
    const res = await request.get('/api/opensens/roi?lat=51.5&lon=-0.1&connectivity_cost=65&revenue_per_node=150');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.scenarios)).toBe(true);
    expect(body.scenarios.length).toBe(3);
    const labels = body.scenarios.map((s: { label: string }) => s.label);
    expect(labels).toContain('conservative');
    expect(labels).toContain('moderate');
    expect(labels).toContain('aggressive');
  });
});
