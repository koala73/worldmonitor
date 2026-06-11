import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function trackedFiles(patterns) {
  const output = execFileSync('git', ['ls-files', ...patterns], {
    cwd: root,
    encoding: 'utf8',
  });
  return output.trim().split('\n').filter(Boolean);
}

test('archival backlog and playground artifacts are not tracked in the repo root', () => {
  const trackedRootArchiveMaterial = trackedFiles([
    'todos/*',
    'plans/*',
    'brief-palette-playground.html',
  ]);

  assert.deepEqual(
    trackedRootArchiveMaterial,
    [],
    `Archive-only material belongs under docs/archive or docs/dev-artifacts, not the repo root:\n${trackedRootArchiveMaterial.join('\n')}`,
  );
});
