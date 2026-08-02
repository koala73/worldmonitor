// Sprint 1 / U8 — static guard for Dockerfile.digest-notifications.
//
// Mirrors tests/dockerfile-relay-imports.test.mjs but extends coverage
// to ALL cross-dir imports (scripts/, shared/, server/_shared/, api/),
// since the digest cron's import graph spans all four. A missing
// transitive import looks like a silent Railway cron crash —
// ERR_MODULE_NOT_FOUND on the child process, sometimes hours before
// anyone notices the digest stopped sending.
//
// The relay Dockerfile guard only catches missing scripts/ COPYs; this
// guard also catches missing shared/, server/_shared/, and api/ COPYs.
// Both directly and recursively (e.g., `COPY scripts/lib/ ./scripts/lib/`
// covers the entire subdirectory).
//
// Historical context (per Dockerfile.relay test header): the
// 2026-04-14→16 chokepoint-flows 32h outage was caused by a missing
// COPY line for an _seed-utils.mjs transitive import. Sprint 1 / U4
// added scripts/lib/digest-delivered-log.mjs and scripts/clear-delivered-entry.mjs
// to the digest cron's import graph; Sprint 1 / U5 added three more
// scripts/lib/digest-cooldown-* modules. Without this guard, a future
// shared-helper extraction could land at the same risk class.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Shared scanner/resolver (comment-stripping tokenizer + edge extraction) —
// one home for the machinery this guard previously copied from the relay
// test; see tests/_lib/import-graph-walk.mjs (#5231 review follow-up).
import { collectRelativeImports, parseDockerfileCopy, resolveNodeRelative } from './_lib/import-graph-walk.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// Scopes the guard checks. Imports OUTSIDE these prefixes are out of
// scope (e.g., node_modules, node:built-ins, top-level package.json
// references resolved by the runtime).
const TRACKED_PREFIXES = ['scripts/', 'shared/', 'server/_shared/', 'api/'];

/**
 * Read the COPY directives from the Dockerfile and split them into
 * file-level and directory-level (recursive) coverage.
 *
 * Matches:
 *   COPY <src> [<src> ...] ./<dest>
 *
 * A trailing slash on a tracked-prefix source means recursive directory
 * coverage (e.g. `scripts/lib/` covers every file under scripts/lib/
 * recursively). Otherwise it's a single-file COPY.
 *
 * @param {string} dockerfilePath
 * @returns {{ files: Set<string>, directories: Set<string> }}
 */
function readCoverage(dockerfilePath) {
  // The COPY grammar itself is parsed by the shared tests/_lib parser so all
  // three container guards read Dockerfiles identically; this guard then
  // scopes coverage to its tracked prefixes (e.g. package.json COPYs are
  // runtime-resolved, not import-graph coverage).
  const parsed = parseDockerfileCopy(readFileSync(dockerfilePath, 'utf-8'));
  const tracked = (set) => new Set([...set].filter((p) => TRACKED_PREFIXES.some((prefix) => p.startsWith(prefix))));
  return { files: tracked(parsed.files), directories: tracked(parsed.directories) };
}

/**
 * Check whether a tracked-prefix file path is covered by either a
 * file-level COPY (exact match) or a directory-level COPY (prefix match).
 */
function isCovered(coverage, relPath) {
  if (coverage.files.has(relPath)) return true;
  for (const dir of coverage.directories) {
    if (relPath === dir) return true;
    if (relPath.startsWith(dir + '/')) return true;
  }
  return false;
}

// Extension candidates for this image: the digest cron's graph spans .ts
// modules under server/_shared/, unlike the relay's .mjs/.cjs-only graph.
const DIGEST_RESOLVE_EXTS = ['.mjs', '.cjs', '.js', '.ts'];

describe('Dockerfile.digest-notifications — transitive-import closure', () => {
  const dockerfile = resolve(root, 'Dockerfile.digest-notifications');
  const coverage = readCoverage(dockerfile);

  it('Dockerfile exists at the repo root', () => {
    assert.ok(existsSync(dockerfile), 'Dockerfile.digest-notifications missing');
  });

  it('coverage parser picks up all four tracked prefixes', () => {
    // Sanity check on the parser: confirm it found at least one COPY
    // per tracked prefix. If the Dockerfile changes shape (e.g., scripts
    // is dropped because everything moved into scripts/lib/), this test
    // surfaces the change explicitly so the operator updates the test.
    const allCovered = [...coverage.files, ...coverage.directories];
    for (const prefix of TRACKED_PREFIXES) {
      const hit = allCovered.some((p) => p.startsWith(prefix));
      assert.ok(hit, `no COPY line found for ${prefix} prefix — Dockerfile.digest-notifications shape changed?`);
    }
  });

  it('seed-digest-notifications.mjs is COPY\'d as the entrypoint', () => {
    assert.ok(
      isCovered(coverage, 'scripts/seed-digest-notifications.mjs'),
      'cron entrypoint not in COPY list',
    );
  });

  it('U4 + U5 modules are covered (scripts/lib/ recursive OR explicit)', () => {
    const u4u5Files = [
      'scripts/lib/digest-delivered-log.mjs',
      'scripts/lib/digest-cooldown-config.mjs',
      'scripts/lib/digest-cooldown-decision.mjs',
      'scripts/lib/digest-cooldown-shadow-log.mjs',
      'scripts/clear-delivered-entry.mjs',
    ];
    for (const f of u4u5Files) {
      assert.ok(
        isCovered(coverage, f),
        `${f} (Sprint 1 / U4 or U5) not covered by any COPY directive`,
      );
    }
  });

  // BFS from the cron entrypoint through the import graph; every
  // tracked-prefix file reached must be covered. Entrypoint is derived
  // from scripts/railway-services.json (the single source of truth for
  // Railway-deployed scripts) — filtered to the digest-notifications
  // Dockerfile so this test stays scoped to its own image.
  it('every transitively-imported tracked-prefix file is COPY\'d', () => {
    const registry = JSON.parse(
      readFileSync(resolve(root, 'scripts/railway-services.json'), 'utf8'),
    );
    const digestEntries = registry
      .filter((r) => r.deployMode === 'dockerfile' && r.dockerfile === 'Dockerfile.digest-notifications')
      .map((r) => resolve(root, r.entry));
    assert.ok(
      digestEntries.length > 0,
      'No registry entry found for Dockerfile.digest-notifications — registry corrupt or out of sync',
    );
    const entrypoints = digestEntries;
    const missing = [];
    const visited = new Set();
    const queue = [...entrypoints];
    while (queue.length) {
      const file = queue.shift();
      if (visited.has(file)) continue;
      visited.add(file);
      if (!existsSync(file)) continue;
      for (const rel of collectRelativeImports(file)) {
        const resolved = resolveNodeRelative(file, rel, DIGEST_RESOLVE_EXTS);
        if (!resolved) continue;
        const relToRoot = resolved.startsWith(root + '/')
          ? resolved.slice(root.length + 1)
          : null;
        if (!relToRoot) continue;
        const tracked = TRACKED_PREFIXES.some((p) => relToRoot.startsWith(p));
        if (!tracked) continue;
        if (!isCovered(coverage, relToRoot)) {
          missing.push(`${relToRoot} (imported by ${file.slice(root.length + 1)})`);
        }
        queue.push(resolved);
      }
    }
    assert.deepEqual(
      missing,
      [],
      `Dockerfile.digest-notifications is missing COPY lines for:\n  ${missing.join('\n  ')}\n` +
      `Add a 'COPY <path> ./<path>' line per missing file (or extend a recursive directory COPY).`,
    );
  });
});
