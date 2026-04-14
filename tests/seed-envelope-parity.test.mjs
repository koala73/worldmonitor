// Drift check for the seed-envelope helpers.
//
// `scripts/verify-seed-envelope-parity.mjs` diffs function bodies between:
//   - scripts/_seed-envelope-source.mjs  (source of truth)
//   - api/_seed-envelope.js              (edge-safe mirror)
//
// This test runs the verifier as a child process during `npm run test:data`
// so drift between the two JS copies fails CI. Without this, someone could
// hand-edit api/_seed-envelope.js and the parity guarantee — which is the
// central invariant PR #3095 introduced — would silently erode.
//
// The TS mirror at server/_shared/seed-envelope.ts is validated by
// `npm run typecheck` and reviewed manually (see header comment in that file).

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const verifier = resolve(here, '..', 'scripts', 'verify-seed-envelope-parity.mjs');

test('seed-envelope parity: source ↔ edge mirror stay in sync', async () => {
  const { stdout, stderr } = await execFileP(process.execPath, [verifier], {
    timeout: 10_000,
  });
  // Verifier prints a one-line OK on success. Any drift would exit non-zero,
  // which execFile surfaces as a thrown error rejecting the promise, so
  // reaching this line means the verifier succeeded.
  assert.match(stdout, /parity: OK/);
  assert.equal(stderr.trim(), '');
});
