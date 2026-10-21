import { test } from '@playwright/test';

import { runWebMcpCancellationScenario } from './helpers/webmcp-cancellation';

const requireWebMcp = process.env.WM_REQUIRE_WEBMCP === '1';
const productionSmoke = process.env.WM_WEBMCP_PRODUCTION === '1';
const deployedSha = process.env.WM_WEBMCP_DEPLOYED_SHA?.trim() || null;

test.describe('WebMCP cold-start cancellation', () => {
  test.skip(
    !requireWebMcp,
    'Requires an installed Chrome with WebMCPTesting enabled; normal browser CI stays model-free.',
  );

  test('completes page work after a caller-side cancel without leaking an unhandled result', async ({ page }, testInfo) => {
    await runWebMcpCancellationScenario(page, testInfo, { deployedSha, productionSmoke });
  });
});
