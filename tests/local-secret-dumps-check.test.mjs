import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  findLocalSecretDumps,
  runLocalSecretDumpCheck,
} from '../scripts/check-local-secret-dumps.mjs';

const makeTempRepo = () => mkdtempSync(join(tmpdir(), 'wm-env-dump-check-'));

describe('local Vercel env dump guard', () => {
  it('passes when forbidden root env dumps are absent', () => {
    const root = makeTempRepo();

    assert.deepEqual(findLocalSecretDumps(root), []);
    assert.doesNotThrow(() => runLocalSecretDumpCheck(root));
  });

  it('fails when .env.vercel-backup exists in the repo root', () => {
    const root = makeTempRepo();
    writeFileSync(join(root, '.env.vercel-backup'), 'do-not-read-this');

    assert.deepEqual(findLocalSecretDumps(root), ['.env.vercel-backup']);
    assert.throws(
      () => runLocalSecretDumpCheck(root),
      /local Vercel env dump files are present/,
    );
  });

  it('fails when .env.vercel-export is a symlink', (t) => {
    const root = makeTempRepo();
    try {
      symlinkSync('/tmp/nonexistent-vercel-env-export', join(root, '.env.vercel-export'));
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip('symlink creation is unavailable in this environment');
        return;
      }
      throw error;
    }

    assert.deepEqual(findLocalSecretDumps(root), ['.env.vercel-export']);
    assert.throws(
      () => runLocalSecretDumpCheck(root),
      /local Vercel env dump files are present/,
    );
  });
});
