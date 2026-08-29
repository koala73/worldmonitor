import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readDotenvValue } from '../scripts/read-dotenv-value.mjs';

test('dotenv reader preserves values without executing shell metacharacters', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-dotenv-'));
  const marker = path.join(root, 'must-not-exist');
  try {
    await fs.writeFile(path.join(root, '.env'), [
      'PLAIN_KEY=plain-value',
      'QUOTED_KEY="quoted value"',
      `SHELL_PAYLOAD=$(touch ${marker})`,
      'BACKTICK_PAYLOAD=`printf owned`',
    ].join('\n'));
    assert.equal(readDotenvValue('PLAIN_KEY', root), 'plain-value');
    assert.equal(readDotenvValue('QUOTED_KEY', root), 'quoted value');
    assert.equal(readDotenvValue('SHELL_PAYLOAD', root), `$(touch ${marker})`);
    // dotenv treats backticks as quote delimiters, but never executes them.
    assert.equal(readDotenvValue('BACKTICK_PAYLOAD', root), 'printf owned');
    await assert.rejects(fs.access(marker));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an inherited export never masks the value written in the file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-dotenv-'));
  const had = Object.prototype.hasOwnProperty.call(process.env, 'GEV_INHERIT_PROBE');
  const previous = process.env.GEV_INHERIT_PROBE;
  try {
    await fs.writeFile(path.join(root, '.env'), 'GEV_INHERIT_PROBE=from-dotenv\n');

    // An empty export is how a shell says "unset" to the launcher's `:-`
    // fallbacks, and Vite's loadEnv otherwise lets process.env win — which is
    // exactly how a configured key went missing.
    process.env.GEV_INHERIT_PROBE = '';
    assert.equal(readDotenvValue('GEV_INHERIT_PROBE', root), 'from-dotenv');

    // A non-empty inherited value must not win either: this reader answers for
    // the files, and the caller decides precedence.
    process.env.GEV_INHERIT_PROBE = 'from-shell';
    assert.equal(readDotenvValue('GEV_INHERIT_PROBE', root), 'from-dotenv');

    // The caller's own environment survives the read unchanged.
    assert.equal(process.env.GEV_INHERIT_PROBE, 'from-shell');

    delete process.env.GEV_INHERIT_PROBE;
    assert.equal(readDotenvValue('GEV_INHERIT_PROBE', root), 'from-dotenv');
    assert.equal(Object.prototype.hasOwnProperty.call(process.env, 'GEV_INHERIT_PROBE'), false);
  } finally {
    if (had) process.env.GEV_INHERIT_PROBE = previous;
    else delete process.env.GEV_INHERIT_PROBE;
    await fs.rm(root, { recursive: true, force: true });
  }
});
