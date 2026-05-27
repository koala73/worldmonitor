import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = new URL('..', import.meta.url).pathname;
const srcRoot = join(repoRoot, 'src');

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
      yield path;
    }
  }
}

test('browser client does not call unauthenticated GitHub REST endpoints directly', async () => {
  const offenders: string[] = [];
  for await (const file of walk(srcRoot)) {
    const source = await readFile(file, 'utf8');
    if (source.includes('api.github.com')) {
      offenders.push(file.replace(repoRoot, ''));
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'anonymous browser loads must not call GitHub REST directly; use a server/cache path or static copy instead'
  );
});
