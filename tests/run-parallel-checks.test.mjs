import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { Writable } from 'node:stream';
import YAML from 'yaml';
import { main } from '../scripts/run-parallel-checks.mjs';

function makeBufferStream() {
  let text = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      text += chunk.toString('utf8');
      cb();
    },
  });
  return { stream, read: () => text };
}

async function withFixture(scripts, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'wm-parallel-checks-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts }));
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('run-parallel-checks', () => {
  it('runs every check and returns 0 when all pass', async () => {
    await withFixture({ a: 'echo alpha', b: 'echo beta', c: 'echo gamma' }, async (dir) => {
      const out = makeBufferStream();
      const err = makeBufferStream();
      const code = await main(['--concurrency=2', 'a', 'b', 'c'], { cwd: dir, stdout: out.stream, stderr: err.stream });
      assert.equal(code, 0);
      assert.match(out.read(), /PASS a /);
      assert.match(out.read(), /PASS b /);
      assert.match(out.read(), /PASS c /);
      assert.match(out.read(), /3\/3 passed/);
      assert.equal(err.read(), '');
    });
  });

  it('runs remaining checks and lists every failure instead of stopping on the first', async () => {
    await withFixture(
      {
        fail1: 'echo first-boom >&2; exit 2',
        ok: 'echo ok-ran',
        fail2: 'echo second-boom >&2; exit 3',
      },
      async (dir) => {
        const out = makeBufferStream();
        const err = makeBufferStream();
        const code = await main(['--concurrency=2', 'fail1', 'ok', 'fail2'], {
          cwd: dir,
          stdout: out.stream,
          stderr: err.stream,
        });
        assert.equal(code, 1);
        assert.match(out.read(), /PASS ok /);
        assert.match(err.read(), /FAIL fail1 .*exit 2/);
        assert.match(err.read(), /first-boom/);
        assert.match(err.read(), /FAIL fail2 .*exit 3/);
        assert.match(err.read(), /second-boom/);
        assert.match(err.read(), /Failed checks \(2\): fail1, fail2/);
      },
    );
  });

  it('rejects unknown script names instead of silently skipping', async () => {
    await withFixture({ a: 'true' }, async (dir) => {
      const out = makeBufferStream();
      const err = makeBufferStream();
      await assert.rejects(
        () => main(['a', 'does-not-exist'], { cwd: dir, stdout: out.stream, stderr: err.stream }),
        /Unknown or empty package\.json script: does-not-exist/,
      );
    });
  });

  it('Lint Code biome job keeps every required lint and sync check wired', () => {
    const root = resolve(import.meta.dirname, '..');
    const workflow = YAML.parse(readFileSync(join(root, '.github/workflows/lint-code.yml'), 'utf8'));
    const biomeSteps = workflow.jobs.biome.steps.flatMap((s) => s.parallel ?? [s]);
    const runText = biomeSteps.map((s) => s.run ?? '').join('\n');
    for (const script of [
      'lint:unicode',
      'lint',
      'lint:boundaries',
      'lint:api-contract',
      'sync:bootstrap-tier-keys:check',
      'sync:live-video-channels:check',
      'sync:tui-catalog:check',
      'lint:rate-limit-policies',
      'lint:premium-fetch',
      'lint:outbound-deadlines',
      'lint:safe-local-storage',
      'lint:overlay-reload-policy',
      'security:vite-env-secrets',
      'version:check',
    ]) {
      assert.ok(
        new RegExp(`(?:^|\\s)${script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`).test(runText),
        `biome job must run ${script}`,
      );
    }
  });
});
