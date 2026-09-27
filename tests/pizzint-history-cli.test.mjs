import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('fixture CLI emits strict JSON and malformed input fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pizzint-history-'));
  const good = join(dir, 'good.json');
  const bad = join(dir, 'bad.json');
  await writeFile(good, '[]');
  await writeFile(bad, '{}');
  const ok = spawnSync(process.execPath, ['scripts/evaluate-pizzint-history.mjs', '--input', good, '--as-of', '2026-09-28T00:00:00Z'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout).counts, { input: 0, included: 0, excluded: 0 });
  const failed = spawnSync(process.execPath, ['scripts/evaluate-pizzint-history.mjs', '--input', bad], { encoding: 'utf8' });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /fixture must be an array/);
});
