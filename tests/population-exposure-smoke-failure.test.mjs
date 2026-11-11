import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
              async addInitScript() {},
              async goto() { throw new Error('Page crashed'); },
              async screenshot() { throw new Error('Page closed'); },
              locator() { return {
                async evaluate() { return []; },
                async innerText() { return 'not mounted'; },
              }; },
            };
            export const chromium = { async launch() { return {
              async newPage() { return page; },
              async close() { writeFileSync(process.env.WM_CHECK_OUTPUT + '/closed', 'yes'); },
            }; } };
          ` }));
        },
      }],
    });
    const run = spawnSync(process.execPath, [outfile], {
      env: { ...process.env, WM_CHECK_OUTPUT: output }, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(run.status, 1, run.stderr);
    const result = JSON.parse(await readFile(join(output, 'result.json'), 'utf8'));
    assert.equal(result.status, 'failed');
    assert.match(result.error, /Page crashed/);
    assert.match(result.screenshotError, /Page closed/);
    assert.equal(await readFile(join(output, 'closed'), 'utf8'), 'yes');
    assert.match(run.stdout, /Page crashed/);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
