import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const srcRoot = join(repoRoot, 'src');
const githubApiUrlPattern = /https?:\/\/api\.github\.com\b/;

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
    // Scope this to browser source. Server/API code may call GitHub with a
    // token or cache; anonymous browser loads must not hit GitHub REST.
    if (githubApiUrlPattern.test(source)) {
      offenders.push(file.replace(repoRoot, ''));
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'anonymous browser loads must not call GitHub REST directly; use a server/cache path or static copy instead'
  );
});
