import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { hangUntilAbort } from './_lib/hang-until-abort.mjs';

test('a request with an already-aborted signal rejects immediately', async () => {
  const reason = new Error('deadline already expired');
  let rejection;
  hangUntilAbort(AbortSignal.abort(reason)).catch(error => { rejection = error; });
  await Promise.resolve();
  assert.equal(rejection, reason);
});

test('a request keeps Node alive until its deadline and releases the timer on abort', () => {
  const helper = new URL('./_lib/hang-until-abort.mjs', import.meta.url).href;
  const source = `
    import { hangUntilAbort } from ${JSON.stringify(helper)};
    const signal = AbortSignal.timeout(20);
    try {
      await hangUntilAbort(signal);
      process.exitCode = 1;
    } catch (error) {
      if (!signal.aborted || error !== signal.reason) process.exitCode = 1;
      else console.log('deadline observed');
    }
  `;
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8', env, timeout: 5_000,
  });
  assert.equal(result.error, undefined, 'the keep-alive must be cleared on abort');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /deadline observed/);
});
