/**
 * Every Railway entry point must announce that it finished.
 *
 * The crash diagnostic (~/.claude/skills/diagnose-railway-seeders) reads a deployment's LOGS to
 * decide whether a run crashed. It is fail-closed: a crash marker wins, `clean` must be positively
 * evidenced by a terminal marker, and anything else is `unknown`. So an entry point that finishes
 * without printing a terminal marker is permanently unvouchable — every one of its runs, healthy or
 * dead, reads the same.
 *
 * That is not hypothetical. `seed-military-flights` crashed on 100% of runs for 7.5h (#6092) while
 * the fleet reported green, and `seed-gpsjam`'s clean runs were indistinguishable from that outage
 * because its last line, `[gpsjam] Wrote seed-meta: …`, ALSO appears in runs that go on to die.
 *
 * Two properties this pins:
 *   1. Every deployable entry point emits a terminal marker.
 *   2. The marker set stays SMALL and CLOSED. Each bespoke spelling is another thing the diagnostic
 *      must learn, and every gap in that vocabulary is a crash reported as healthy. New entry points
 *      should use runSeed(), or print `=== Done (Nms) ===` as their genuine last act.
 *
 * MARKER PLACEMENT IS THE WHOLE POINT: it must be reachable ONLY after all work succeeded —
 * `.then()` on the top-level promise, or the last statement of the success path. A marker printed
 * mid-run vouches for a run that may still die afterwards, which is exactly how #6092 hid.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

/**
 * Does this source emit a terminal marker — a line that only prints once the run has finished?
 * PURE and unit-tested by the fixtures below (not exported — biome forbids exports in tests); a bare inline grep in the assertion loop
 * could be loosened later and still "pass" against real files that happen to match.
 */
/**
 * Strip comments so prose can never satisfy the marker regexes.
 *
 * This is not defensive tidiness — without it this guard was VACUOUS. Each seeder fixed alongside
 * this test carries a comment explaining the marker, and those comments say "runSeed()" and
 * "=== Done". Deleting the actual marker left the comment behind, the predicate matched the
 * COMMENT, and the mutation test passed with the bug fully restored.
 *
 * Deliberately simple: a `//` inside a string literal (a URL, say) truncates that line early. That
 * can only DROP text, so the failure direction is a false "missing marker" — a loud test failure,
 * never a silent pass.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')  // block comments
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

function hasTerminalMarker(rawSrc: string): boolean {
  const src = stripComments(rawSrc);
  return (
    /\brunSeed\s*\(/.test(src) ||               // shared runner prints `=== Done (Nms) ===`
    /===\s*Done\b/.test(src) ||                  // printed directly
    /exiting 0 \(not a crash\)/.test(src) ||     // scripts/_bundle-runner.mjs clean exit
    /_bundle-runner/.test(src) ||                // delegates to the bundle runner
    // A long-running service's shutdown handler. Matched on the HANDLER REGISTRATION, not on the
    // logged text: ais-relay.cjs builds its line as `[Relay] ${signal} received`, so grepping the
    // source for the literal "SIGTERM received" finds nothing even though the runtime output has
    // it. Source-level guards must match what is WRITTEN, not what is printed.
    /process\.on\(\s*['"`]SIGTERM['"`]/.test(src) ||
    // Pre-existing bespoke markers (seed-digest-notifications, seed-webcams, seed-military-bases).
    // Recognised because the diagnostic already knows them — but they are exactly the vocabulary
    // sprawl this test exists to stop growing. New entry points must use `=== Done`.
    /Cron run complete|Seeding complete|: done \(/.test(src)
  );
}

/**
 * Is this source executed directly by Railway, rather than only imported?
 * Deliberately BROAD: a narrow detector that silently stops matching is how a guard goes vacuous,
 * and a false positive here costs one `=== Done ===` line while a false negative costs an
 * unvouchable service. `process-*-tasks.mjs` are top-level-await scripts with no guard at all, so
 * "has no export" counts too.
 */
function isEntryPoint(src: string): boolean {
  return (
    /import\.meta\.url\s*===/.test(src) ||
    /process\.argv\[1\]/.test(src) ||
    /\b(isMain|DIRECT_RUN|isDirectRun)\b/.test(src) ||
    !/^export\s/m.test(src)
  );
}

// Deployable surface: the filesystem, NOT scripts/railway-services.json. That registry documents
// only 41 services and omits 6 of the entry points fixed alongside this test — it is documentation
// that drifts, so a guard built on it inherits its holes.
const DEPLOYABLE = /^(seed-|fetch-|process-|publish-|.*-relay|.*-worker)/;

/**
 * Named like a service but NOT run by Railway — verified against live Railway `startCommand`s on
 * 2026-08-04 (every one of these resolved to no service). Two kinds:
 *   - bundle MEMBERS, spawned as children by scripts/_bundle-runner.mjs. The bundle is the entry
 *     point and prints the terminal marker; a member printing its own would be a mid-run line.
 *   - one-shot developer/data-prep utilities that never run on a schedule.
 * Regenerate with: railway serviceInstance{startCommand} across all services (see issue #6141).
 */
const NOT_A_RAILWAY_SERVICE = new Set([
  'ais-relay-test-preload.cjs',            // test harness preload
  'fetch-country-boundary-overrides.mjs',  // one-shot data prep
  'fetch-mirta-bases.mjs',
  'fetch-osm-bases.mjs',
  'fetch-pizzint-bases.mjs',
  'seed-consumer-prices.mjs',              // superseded by consumer-prices-core/dist jobs
  'seed-gas-storage-countries.mjs',        // bundle member
  'seed-gdelt-intel.mjs',
  'seed-owid-energy-mix.mjs',
  'seed-recall-benchmark.mjs',
  'seed-regional-briefs.mjs',
  'seed-regional-snapshots.mjs',
  'seed-resilience-scores.mjs',
  'seed-resilience-static.mjs',
]);

function collectEntryPoints(): { path: string; src: string }[] {
  const out: { path: string; src: string }[] = [];
  const scriptsDir = join(repoRoot, 'scripts');
  for (const name of readdirSync(scriptsDir)) {
    if (!/\.(mjs|cjs)$/.test(name)) continue;
    if (/\.test\.(mjs|cjs)$/.test(name)) continue;
    if (!DEPLOYABLE.test(name)) continue;
    if (NOT_A_RAILWAY_SERVICE.has(name)) continue;
    const p = join(scriptsDir, name);
    const src = readFileSync(p, 'utf8');
    if (!isEntryPoint(src)) continue;
    out.push({ path: `scripts/${name}`, src });
  }
  // The consumer-prices jobs live in their own package and are run from built dist/ output.
  const jobsDir = join(repoRoot, 'consumer-prices-core/src/jobs');
  if (existsSync(jobsDir)) {
    for (const name of ['scrape.ts', 'publish.ts', 'aggregate.ts']) {
      const p = join(jobsDir, name);
      if (existsSync(p)) out.push({ path: `consumer-prices-core/src/jobs/${name}`, src: readFileSync(p, 'utf8') });
    }
  }
  return out;
}

describe('hasTerminalMarker predicate', () => {
  it('accepts each shape currently in use', () => {
    assert.equal(hasTerminalMarker('await runSeed({ domain: "x" })'), true, 'runSeed');
    assert.equal(hasTerminalMarker('console.log(`\\n=== Done (${ms}ms) ===`)'), true, 'direct');
    assert.equal(hasTerminalMarker('[Bundle:x] 1 graceful fetch skip(s), no hard failures — exiting 0 (not a crash)'), true, 'bundle');
    assert.equal(hasTerminalMarker("process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));"), true, 'sigterm handler');
    assert.equal(hasTerminalMarker('console.log(`[digest] Cron run complete: ${n} sent`)'), true, 'bespoke');
  });

  it('matches the SOURCE, not the runtime output', () => {
    // ais-relay.cjs logs `[Relay] ${signal} received — shutting down`, so the literal string
    // "SIGTERM received" never appears in the file even though it appears in every log. Matching
    // the interpolated output is why three real services first read as unvouchable here.
    assert.equal(hasTerminalMarker('console.log(`[Relay] ${signal} received — shutting down`)'), false);
  });

  it('ignores markers that appear only in COMMENTS', () => {
    // The exact false pass this guard shipped with: every seeder fixed alongside this test has a
    // comment mentioning runSeed()/=== Done, so before stripComments() the mutation test could
    // delete the real marker and still go green.
    assert.equal(hasTerminalMarker('// Format mirrors runSeed() so the diagnostic recognises it'), false);
    assert.equal(hasTerminalMarker('/* prints === Done (Nms) === at the end */'), false);
    assert.equal(hasTerminalMarker('// exiting 0 (not a crash)'), false);
    // …but the real thing still counts when both are present.
    assert.equal(hasTerminalMarker('// mirrors runSeed()\nconsole.log(`\\n=== Done (${ms}ms) ===`);'), true);
  });

  it('REJECTS a mid-run line that merely looks final', () => {
    // The seed-gpsjam trap: this was its genuine last line on a clean run, and is also present in
    // runs that crash immediately afterwards. Accepting it would re-open the #6092 blind spot.
    assert.equal(hasTerminalMarker('console.log(`[gpsjam] Wrote seed-meta: ${key}`)'), false);
    assert.equal(hasTerminalMarker('console.log("  Verified: yes")'), false);
    assert.equal(hasTerminalMarker('console.log(`  ${LIVE_KEY}: written`)'), false);
    assert.equal(hasTerminalMarker(''), false);
  });
});

describe('every Railway entry point emits a terminal marker', () => {
  const entries = collectEntryPoints();

  it('finds a plausible number of entry points (anti-vacuous)', () => {
    // Without this, a broken DEPLOYABLE/isEntryPoint pair would check nothing and still go green.
    assert.ok(entries.length >= 40, `only found ${entries.length} entry points — the collector is broken, not the fleet`);
  });

  it('has no unvouchable entry point', () => {
    const missing = entries.filter((e) => !hasTerminalMarker(e.src)).map((e) => e.path);
    assert.deepEqual(
      missing,
      [],
      `These entry points finish without printing a terminal marker, so the crash diagnostic can ` +
      `never tell a clean run from a silent death:\n  ${missing.join('\n  ')}\n\n` +
      `Fix: use runSeed(), or print \`=== Done (\${Date.now() - startedAt}ms) ===\` as the genuine ` +
      `LAST act of the success path (a .then() on the top-level promise). Do NOT print it mid-run.`,
    );
  });
});
