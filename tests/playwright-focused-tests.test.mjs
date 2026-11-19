import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');

test('Playwright rejects focused tests in CI and permits local focus', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wm-playwright-focus-'));
  try {
    writeFileSync(join(dir, 'playwright.config.ts'), `
      import config from ${JSON.stringify(join(root, 'playwright.config.ts'))};
      export default {
        ...config,
        testDir: ${JSON.stringify(dir)},
        testMatch: '**/focus.spec.ts',
        webServer: undefined,
        reporter: [['list']],
        outputDir: ${JSON.stringify(join(dir, 'results'))},
        projects: [{ name: 'policy' }],
      };
    `);
    writeFileSync(join(dir, 'focus.spec.ts'), `
      import { test, expect } from ${JSON.stringify(require.resolve('@playwright/test'))};
      test.only('focused test', () => { expect(1).toBe(1); });
      test('excluded failure', () => { expect(1).toBe(2); });
    `);
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('WM_WEBMCP_') || key === 'WM_REQUIRE_WEBMCP' || key === 'NODE_TEST_CONTEXT') delete env[key];
    }
    const run = (ci) => {
      const probeEnv = { ...env };
      if (ci) probeEnv.CI = '1';
      else delete probeEnv.CI;
      const result = spawnSync(process.execPath, [
        require.resolve('@playwright/test/cli'), 'test', '--config', join(dir, 'playwright.config.ts'),
      ], { cwd: root, env: probeEnv, encoding: 'utf8', timeout: 30_000 });
      assert.ifError(result.error);
      return { status: result.status, output: result.stdout + result.stderr };
    };
    const ci = run(true);
    assert.equal(ci.status, 1, ci.output);
    assert.match(ci.output, /focused.*\.only.*not allowed/);
    const local = run(false);
    assert.equal(local.status, 0, local.output);
    assert.match(local.output, /1 passed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
