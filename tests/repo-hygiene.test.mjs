import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('completed todo notes are not tracked as active repo backlog', () => {
  const output = execFileSync('git', ['ls-files', 'todos/*-complete-*'], {
    cwd: root,
    encoding: 'utf8',
  });
  const trackedCompleteTodos = output.trim().split('\n').filter(Boolean);

  assert.deepEqual(
    trackedCompleteTodos,
    [],
    `Closed todo notes belong in their issue/PR history, not the tracked repo backlog:\n${trackedCompleteTodos.join('\n')}`,
  );
});
