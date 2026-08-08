// Guards against the issue-#3845 triplication finding: the CISS content-age /
// staleness threshold (10 days) lives in the seeder (canonical) and is
// mirrored ONCE for TypeScript code in src/shared/ciss-staleness.ts. The
// seeder is plain .mjs and cannot be imported by TS app/server code, so one
// mirror is unavoidable — this test fails if the two drift, or if the server
// RPC / panel reintroduce a local copy instead of importing the shared one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('CISS stale threshold: canonical seeder value and shared TS mirror agree', () => {
  const seeder = read('scripts/seed-fsi-eu.mjs');
  const shared = read('src/shared/ciss-staleness.ts');

  const seederMatch = /CISS_MAX_CONTENT_AGE_MIN\s*=\s*(\d+)\s*\*\s*DAY_MIN/.exec(seeder);
  assert.ok(seederMatch, 'could not find `CISS_MAX_CONTENT_AGE_MIN = N * DAY_MIN` in seed-fsi-eu.mjs');
  const seederDays = Number(seederMatch[1]);

  const sharedMatch = /CISS_STALE_THRESHOLD_DAYS\s*=\s*(\d+)/.exec(shared);
  assert.ok(sharedMatch, 'could not find `CISS_STALE_THRESHOLD_DAYS = N` in src/shared/ciss-staleness.ts');
  const sharedDays = Number(sharedMatch[1]);

  assert.equal(
    seederDays,
    sharedDays,
    `CISS threshold drift: seeder = ${seederDays}d, src/shared/ciss-staleness.ts = ${sharedDays}d. ` +
      `The seeder is canonical — update CISS_STALE_THRESHOLD_DAYS to match it.`,
  );

  // The _MS constant must be derived from _DAYS, not written as a 2nd literal.
  assert.match(
    shared,
    /CISS_STALE_THRESHOLD_MS\s*=\s*CISS_STALE_THRESHOLD_DAYS\s*\*/,
    'CISS_STALE_THRESHOLD_MS must be derived from CISS_STALE_THRESHOLD_DAYS, not a separate literal',
  );
});

test('server RPC and panel import the shared CISS threshold — no local copy', () => {
  for (const path of [
    'server/worldmonitor/economic/v1/get-eu-fsi.ts',
    'src/components/FSIPanel.ts',
  ]) {
    const src = read(path);
    assert.match(
      src,
      /import\s*\{[^}]*CISS_STALE_THRESHOLD_MS[^}]*\}\s*from\s*['"][^'"]*shared\/ciss-staleness['"]/,
      `${path} must import CISS_STALE_THRESHOLD_MS from src/shared/ciss-staleness`,
    );
    assert.doesNotMatch(
      src,
      /\bconst\s+CISS_STALE_THRESHOLD_MS\s*=/,
      `${path} must not define its own CISS_STALE_THRESHOLD_MS — import the shared constant instead`,
    );
  }
});
