import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
  compareAxeViolationBaseline,
  type KnownAxeViolationBaseline,
} from './axe-violation-baseline';

/**
 * Automated axe-core scan of the hydrated dashboard (#6573).
 *
 * Biome's a11y lint group only analyzes JSX, so the template-string DOM this
 * app builds gets zero static a11y coverage — this scan is the regression
 * gate that role. It runs the WCAG 2.x A/AA rule tags and fails when a
 * violation appears for any rule NOT already on the known-violations list
 * below.
 *
 * The known-violation baselines identify exact rule-and-target pairs. A new
 * node under an already-known rule fails, and a target that stops firing must
 * be deleted. Both baselines are empty as of introduction.
 *
 * CI invokes this file via `npm run test:e2e:ci-smoke` (nothing in CI runs
 * the `e2e/` glob). `REQUIRED_CI_SMOKE_SPECS` pins the argv token.
 */

async function loadDashboard(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.documentElement.dataset.wmInitialDataReady === 'true',
    undefined,
    { timeout: 60_000 },
  );
  await page.locator('[role="tablist"]').first().waitFor({ timeout: 30_000 });
  await page.locator('#panelsGrid .panel').first().waitFor({ timeout: 30_000 });
}

// Empty as of introduction (the #6573 remediation PRs cleared the backlog axe
// can detect). If a violation must temporarily ship, record every exact target
// fingerprint under its rule WITH a link to a tracking issue. Empty rule entries
// are rejected so this cannot degrade back into a rule-wide allowlist.
const KNOWN_VIOLATIONS = {} satisfies KnownAxeViolationBaseline;

const KNOWN_SETTINGS_VIOLATIONS = {} satisfies KnownAxeViolationBaseline;

type AxeResults = Awaited<ReturnType<AxeBuilder['analyze']>>;

function assertOnlyKnownViolations(
  results: AxeResults,
  known: KnownAxeViolationBaseline,
  surface: string,
): void {
  const comparison = compareAxeViolationBaseline(results.violations, known);
  const unexpected = results.violations.filter((v) => comparison.unexpectedRuleIds.includes(v.id));

  const describe = (vs: AxeResults['violations']) =>
    vs.map((v) =>
      `${v.id} (${v.impact}): ${v.help}\n` +
      v.nodes.slice(0, 5).map((n) => `    ${n.target.join(' ')}`).join('\n') +
      (v.nodes.length > 5 ? `\n    …and ${v.nodes.length - 5} more nodes` : ''),
    ).join('\n\n');

  expect(
    unexpected,
    `New axe violations on ${surface} (not on the known backlog):\n\n${describe(unexpected)}`,
  ).toEqual([]);

  expect(
    comparison.invalidBaselineRuleIds,
    `Known violations for ${surface} must list exact target fingerprints; empty rules are not allowed`,
  ).toEqual([]);
  expect(
    comparison.expandedTargets,
    `Known axe rules gained new violating targets on ${surface}: ${comparison.expandedTargets.join(', ')}`,
  ).toEqual([]);
  expect(
    comparison.staleTargets,
    `These known axe targets for ${surface} no longer fire — delete them: ${comparison.staleTargets.join(', ')}`,
  ).toEqual([]);
}

test.describe('a11y — axe-core WCAG A/AA scan', () => {
  test('dashboard has no axe violations outside the known backlog', async ({ page }) => {
    await loadDashboard(page);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      // Vite's dev-server error overlay is tooling, not app UI; without this
      // an unrelated local build hiccup would fail the a11y gate.
      .exclude('vite-error-overlay')
      .analyze();

    console.log(`[axe] scanned=${results.passes.reduce((a, p) => a + p.nodes.length, 0)} pass-nodes, incomplete=${results.incomplete.map((i) => `${i.id}:${i.nodes.length}`).join(',') || 'none'}`);
    console.log(`[axe] violations: ${JSON.stringify(results.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target })), null, 2)}`);

    // Sanity: an empty page would also produce zero violations. Require real
    // scanned content so a broken boot can't masquerade as a green scan.
    expect(results.passes.reduce((a, p) => a + p.nodes.length, 0)).toBeGreaterThan(100);

    assertOnlyKnownViolations(results, KNOWN_VIOLATIONS, 'the dashboard');
  });

  test('settings dialog has no axe violations outside the known backlog', async ({ page }) => {
    // Cold dashboard boot + the lazy UnifiedSettings chunk + axe, under the
    // 4-worker ci-smoke pool, regularly burns the default 90s clock. Job
    // 98862790240 on #7271 logged `[axe:settings] violations: []` on both
    // the first attempt and retry #1, then died with "Test timeout of
    // 90000ms exceeded" — not an a11y regression. Same budget pattern as
    // variant-live-smoke / visual-chrome.
    test.setTimeout(180_000);

    await loadDashboard(page);
    const settingsBtn = page.locator('#unifiedSettingsBtn');
    await expect(settingsBtn).toBeVisible({ timeout: 60_000 });
    await settingsBtn.click();
    await page.locator('#unifiedSettingsModal.active').waitFor({ timeout: 30_000 });

    const results = await new AxeBuilder({ page })
      .include('#unifiedSettingsModal')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    console.log(`[axe:settings] violations: ${JSON.stringify(results.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target })), null, 2)}`);
    expect(results.passes.reduce((a, p) => a + p.nodes.length, 0)).toBeGreaterThan(20);

    assertOnlyKnownViolations(results, KNOWN_SETTINGS_VIOLATIONS, 'the settings dialog');
  });
});
