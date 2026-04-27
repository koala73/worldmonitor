// U4 prefix-bump audit (per cache-prefix-bump-propagation-scope learning).
//
// The classify cache prefix lives in three independent sites:
//   1. server/worldmonitor/intelligence/v1/_shared.ts — canonical writer
//      (CLASSIFY_CACHE_PREFIX constant + buildClassifyCacheKey helper)
//   2. server/worldmonitor/news/v1/list-feed-digest.ts — digest reader
//      (now imports buildClassifyCacheKey from the shared module above)
//   3. scripts/ais-relay.cjs — relay reader+writer (independent inline
//      helper, cannot import from .ts)
//
// When the prefix is bumped (v3 → v4 → v5 …), all three sites MUST update
// in lockstep. This static-analysis test fails if any literal `classify:
// sebuf:vN:` string in the repo doesn't match the current canonical
// version — preventing the relay from getting silently left behind on
// the previous prefix (which would mean it keeps writing+reading poisoned
// entries at the old key while the digest reads from the new one).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

// Read canonical version from _shared.ts. Single source of truth.
const sharedSrc = readFileSync(
  resolve(repoRoot, 'server/worldmonitor/intelligence/v1/_shared.ts'),
  'utf-8',
);

const PREFIX_RE = /CLASSIFY_CACHE_PREFIX\s*=\s*'classify:sebuf:(v\d+):'/;
const sharedMatch = sharedSrc.match(PREFIX_RE);

describe('classify cache prefix audit (U4)', () => {
  it('canonical prefix is defined in _shared.ts', () => {
    assert.ok(sharedMatch, 'CLASSIFY_CACHE_PREFIX not found in _shared.ts');
  });

  it('every literal classify:sebuf:vN in the repo matches the canonical version', () => {
    if (!sharedMatch) {
      assert.fail('canonical prefix not found — earlier test should have caught this');
    }
    const canonical = sharedMatch[1]; // e.g., 'v4'

    // Grep across .ts/.mjs/.cjs/.js/.json — same extensions the
    // cache-prefix-bump-propagation-scope learning calls out. Excludes
    // node_modules, .git, dist/build outputs.
    let grepOut = '';
    try {
      grepOut = execSync(
        `grep -rnE "classify:sebuf:v[0-9]+" \
          --include="*.ts" --include="*.mjs" --include="*.cjs" \
          --include="*.js" --include="*.json" \
          --exclude-dir=node_modules --exclude-dir=.git \
          --exclude-dir=dist --exclude-dir=build \
          --exclude-dir=coverage \
          ${repoRoot}`,
        { encoding: 'utf-8' },
      );
    } catch (err) {
      // grep exits non-zero when no matches; that's a different failure
      // (audit infrastructure broken, not a prefix mismatch).
      if (err && err.status !== 1) throw err;
      grepOut = (err && err.stdout) ?? '';
    }

    const lines = grepOut.split('\n').filter((l) => l.length > 0);
    const offenders = [];
    for (const line of lines) {
      // Skip the test file itself — its grep regex literal would
      // false-match. Identified by its filename rather than path so the
      // exclusion stays robust across worktrees / CI checkout layouts.
      if (line.includes('news-classify-cache-prefix-audit.test.mjs')) continue;
      const m = line.match(/classify:sebuf:(v\d+)/);
      if (!m) continue;
      if (m[1] !== canonical) {
        offenders.push(line);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `Found ${offenders.length} site(s) referencing a non-canonical ` +
        `classify cache prefix (canonical = ${canonical}). All sites must ` +
        `update in lockstep when bumping the prefix. Offenders:\n  ` +
        offenders.join('\n  '),
    );
  });
});
