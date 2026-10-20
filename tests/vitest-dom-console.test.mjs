import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cache = join(root, 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });
const fixture = mkdtempSync(join(cache, 'vitest-dom-console-'));
after(() => rmSync(fixture, { recursive: true, force: true }));

writeFileSync(join(fixture, 'vitest.config.mts'), `
import { mergeConfig } from 'vitest/config';
import base from ${JSON.stringify(join(root, 'vitest.dom.config.mts'))};
export default mergeConfig(base, {
  root: import.meta.dirname,
  test: {
    include: ['probe.test.mts'],
    reporters: ['default', './reporter.mjs'],
    fileParallelism: false,
    maxWorkers: 1,
  },
});
`);

writeFileSync(join(fixture, 'reporter.mjs'), `
import { setTimeout } from 'node:timers/promises';
export default class SlowConsoleReporter {
  async onUserConsoleLog(log) {
    await setTimeout(log.content.includes('late-log') ? 2000 : 500);
    process.stdout.write(log.content);
  }
}
`);

/**
 * A child process isolates the deliberately failing Vitest probes from this node:test run.
 */
function runProbe(source) {
  writeFileSync(join(fixture, 'probe.test.mts'), source);
  const result = spawnSync(process.execPath, [
    join(root, 'node_modules/vitest/vitest.mjs'),
    'run', '--config', join(fixture, 'vitest.config.mts'),
  ], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { status: result.status, output: result.stdout + result.stderr };
}

describe('DOM runner console transport', () => {
  it('keeps stdout/stderr visible without pending console RPCs at teardown', () => {
    const result = runProbe(`
      import { expect, it } from 'vitest';
      import { setTimeout } from 'node:timers';
      it('logs while the first console acknowledgement is pending', () => {
        console.log('runner-stdout-probe');
        console.warn('runner-stderr-probe');
        setTimeout(() => console.warn('late-log'), 50);
        expect(1).toBe(1);
      });
    `);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /runner-stdout-probe/);
    assert.match(result.output, /runner-stderr-probe/);
    assert.doesNotMatch(result.output, /EnvironmentTeardownError/);
  });

  it('still fails on an assertion failure', () => {
    const result = runProbe(`
      import { expect, it } from 'vitest';
      it('fails an assertion', () => expect('actual').toBe('expected'));
    `);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /AssertionError/);
  });

  it('still fails on an unhandled rejection after a passing assertion', () => {
    const result = runProbe(`
      import { expect, it } from 'vitest';
      import { setTimeout } from 'node:timers/promises';
      it('passes with an unhandled rejection', async () => {
        Promise.reject(new Error('runner-unhandled-probe'));
        await setTimeout(20);
        expect(1).toBe(1);
      });
    `);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /Unhandled Rejection/);
    assert.match(result.output, /runner-unhandled-probe/);
  });
});
