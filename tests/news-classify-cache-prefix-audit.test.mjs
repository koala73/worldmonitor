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
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
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
    // node_modules, local worktrees, and generated build outputs.
    const allowedExtensions = ['.ts', '.mjs', '.cjs', '.js', '.json'];
    const excludePatterns = ['node_modules', '.git', '.claude', 'dist', 'build', 'coverage', 'target'];
    const results = [];

    function walk(currentDir) {
      let entries;
      try {
        entries = readdirSync(currentDir);
      } catch (err) {
        return;
      }
      for (const entry of entries) {
        const fullPath = resolve(currentDir, entry);
        const relPath = relative(repoRoot, fullPath).replace(/\\/g, '/');
        const parts = relPath.split('/');

        if (parts.some((part) => excludePatterns.includes(part))) {
          continue;
        }

        let stat;
        try {
          stat = statSync(fullPath);
        } catch (err) {
          continue;
        }

        if (stat.isDirectory()) {
          walk(fullPath);
        } else {
          const extIdx = entry.lastIndexOf('.');
          const ext = extIdx !== -1 ? entry.substring(extIdx) : '';
          if (allowedExtensions.includes(ext)) {
            let content;
            try {
              content = readFileSync(fullPath, 'utf8');
            } catch (err) {
              continue;
            }
            if (content.includes('classify:sebuf:v')) {
              const lines = content.split(/\r?\n/);
              lines.forEach((line, index) => {
                if (/classify:sebuf:v[0-9]+/.test(line)) {
                  results.push(`${fullPath.replace(/\\/g, '/')}:${index + 1}:${line}`);
                }
              });
            }
          }
        }
      }
    }

    walk(repoRoot);
    const grepOut = results.join('\n');

    // Sanity floor: the canonical writer (_shared.ts) must always appear in
    // the scan output. Guards against a silently-empty grep (e.g. a future
    // path/flag change) passing the offenders check vacuously and masking a
    // real prefix mismatch.
    assert.ok(
      grepOut.includes('intelligence/v1/_shared.ts'),
      'classify-prefix scan returned no _shared.ts hit — the audit grep did not run over the source tree',
    );

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
