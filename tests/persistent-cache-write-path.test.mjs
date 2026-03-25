import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const mainRs = readFileSync(
  path.join(repoRoot, 'src-tauri/src/main.rs'),
  'utf8',
);

test('write_cache_entry defers disk persistence instead of writing synchronously', () => {
  const match = mainRs.match(/fn write_cache_entry[\s\S]*?\n}\n\nfn logs_dir_path/);
  assert.ok(match, 'write_cache_entry should exist in main.rs');

  const writeFn = match[0];
  assert.doesNotMatch(writeFn, /std::fs::write/, 'write_cache_entry should not write the cache file synchronously');
  assert.match(writeFn, /schedule_cache_flush\(&app\);/, 'write_cache_entry should hand disk persistence to a deferred flush path');
});
