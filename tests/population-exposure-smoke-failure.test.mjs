import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { it } from 'node:test';

it('saves the smoke-check failure and closes the browser when screenshots fail', async () => {
  const output = await mkdtemp(join(tmpdir(), 'wm-exposure-crash-'));
  try {
    const outfile = join(output, 'check.mjs');
    await build({
      entryPoints: [resolve('scripts/check-population-exposure.mjs')],
      outfile, bundle: true, platform: 'node', format: 'esm',
      plugins: [{
        name: 'crashed-browser',
        setup(builder) {
          builder.onResolve({ filter: /^@playwright\/test$/ }, () => ({ path: 'browser', namespace: 'fixture' }));
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
            import { writeFileSync } from 'node:fs';
            const page = {
              async addInitScript() { if (process.env.WM_TEST_FAILURE === 'profile') throw new Error('Profile failed'); },
              async goto() { throw new Error('Page crashed'); },
              async screenshot() { throw new Error('Page closed'); },
              locator() { return {
                async evaluate() { return []; },
                async innerText() { return 'not mounted'; },
              }; },
            };
            export const chromium = { async launch() { return {
              async newPage() { if (process.env.WM_TEST_FAILURE === 'newPage') throw new Error('New page failed'); return page; },
              async close() { writeFileSync(process.env.WM_CHECK_OUTPUT + '/closed', 'yes'); },
            }; } };
          ` }));
        },
      }],
    });
    await writeFile(join(output, 'rows.png'), 'previous run');
    const run = spawnSync(process.execPath, [outfile], {
      env: { ...process.env, WM_CHECK_OUTPUT: output }, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(run.status, 1, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.output.startsWith(join(output, 'run-')), true);
    assert.deepEqual(await readdir(result.output), ['result.json']);
    assert.deepEqual(JSON.parse(await readFile(join(result.output, 'result.json'), 'utf8')), result);
    assert.equal(result.status, 'failed');
    assert.match(result.error, /Page crashed/);
    assert.match(result.screenshotError, /Page closed/);
    assert.equal(await readFile(join(output, 'closed'), 'utf8'), 'yes');
    assert.match(run.stdout, /Page crashed/);
    const second = spawnSync(process.execPath, [outfile], {
      env: { ...process.env, WM_CHECK_OUTPUT: output }, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(second.status, 1, second.stderr);
    const secondResult = JSON.parse(second.stdout);
    assert.notEqual(secondResult.output, result.output);
    assert.deepEqual(await readdir(secondResult.output), ['result.json']);
    for (const [stage, message] of [['newPage', 'New page failed'], ['profile', 'Profile failed']]) {
      await rm(join(output, 'closed'));
      const setupFailure = spawnSync(process.execPath, [outfile], {
        env: { ...process.env, WM_CHECK_OUTPUT: output, WM_TEST_FAILURE: stage }, encoding: 'utf8', timeout: 10_000,
      });
      assert.equal(setupFailure.status, 1, setupFailure.stderr);
      const setupResult = JSON.parse(setupFailure.stdout);
      assert.equal(setupResult.error, `Error: ${message}`);
      assert.deepEqual(JSON.parse(await readFile(join(setupResult.output, 'result.json'), 'utf8')), setupResult);
      assert.equal(await readFile(join(output, 'closed'), 'utf8'), 'yes');
    }
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
