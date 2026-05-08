// Static guard: every bundle-driven seeder's canonical-key TTL must be
// AT LEAST 3× its bundle's `intervalMs` (the gold-standard from
// api/health.js:268-281 and memory `seed-meta-populated-canonical-missing-
// ttl-cron-match`).
//
// Why: when canonical TTL ≈ cron interval, ANY drift (cron queue delay,
// LLM-call slowness, bundle ordering) leaves the canonical key TTL'd-out
// for a window before the next successful run rewrites it. seed-meta has
// a much longer TTL so it survives showing rc>0; /api/health then reports
// `EMPTY records=0` while the meta says everything's fresh — the operator
// sees no diagnostic trail.
//
// The trap has bitten WM at least 3 times so far:
//   - PR #3610 (bisPolicy/bisExchange/bisCredit, 12h TTL == 12h cron)
//   - PR #3622 (marketImplications, 75min TTL vs 60min cron — 1.25×)
//   - PR #3622 (iranEvents, 2d TTL vs 14d operator-cadence — 0.28×)
//
// This test catches new instances on every contribution rather than after
// the first production failure.
//
// ## Known violations (allowlisted)
//
// At test-creation time, scanning all `scripts/seed-bundle-*.mjs` surfaced
// ~30 sections currently below the 3× threshold. Each is listed below
// with its current ratio. The test fails if:
//
//   (a) A NEW section drops below the threshold (regression — must fix or
//       add to the allowlist with a comment justifying why)
//   (b) An ALLOWLISTED entry is no longer violating (resolved — remove
//       the entry, otherwise the allowlist drifts)
//
// As future PRs bump TTLs, contributors should remove the corresponding
// allowlist entry. Goal: empty allowlist.
//
// ## Scope
//
//   INCLUDES: every section across `scripts/seed-bundle-*.mjs` where the
//   section has `script:` + `intervalMs:` AND the script uses
//   `runSeed(...)` with `ttlSeconds:`. That's the standard bundle+runSeed
//   shape.
//
//   EXCLUDES: non-bundle seeders (manually-triggered like seed-iran-
//   events.mjs OR external-cron like seed-forecasts.mjs's market-
//   implications). Those don't have a discoverable cron interval in code;
//   they were audited manually in PR #3622.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SCRIPTS_DIR = join(ROOT, 'scripts');

const SAFETY_FACTOR = 3;     // canonical TTL must be ≥ this × cron interval

// Allowlist of bundle sections currently below threshold — keyed by
// `<bundle-label>:<script>` to allow precise removal. Format:
//   '<label>:<script>': '<short justification>'
//
// Each entry should be removed when its corresponding seeder is fixed.
// Adding a new entry requires a comment explaining why the violation is
// acceptable (or "TODO: fix in follow-up PR").
const KNOWN_VIOLATIONS = {
  // ── Climate ──
  'CO2-Monitoring:seed-co2-monitoring.mjs': '72h TTL vs 72h cron (1×) — needs bump to ≥216h',
  'Cross-Source-Signals:seed-cross-source-signals.mjs': '30min TTL vs 15min cron (2×) — borderline',
  'FSI-EU:seed-fsi-eu.mjs': '240h TTL vs 168h cron (1.43×)',
  'IEA-Oil-Stocks:seed-iea-oil-stocks.mjs': '40d TTL vs 40d cron (1×) — needs bump to ≥120d',

  // ── Macro / IMF / WB cohort ──
  'IMF-Macro:seed-imf-macro.mjs': '35d TTL vs 30d cron (1.17×)',
  'IMF-Growth:seed-imf-growth.mjs': '35d TTL vs 30d cron (1.17×)',
  'IMF-Labor:seed-imf-labor.mjs': '35d TTL vs 30d cron (1.17×)',
  'IMF-External:seed-imf-external.mjs': '35d TTL vs 30d cron (1.17×)',
  'National-Debt:seed-national-debt.mjs': '65d TTL vs 30d cron (2.17×) — close, could just bump to 90d',
  'WB-External-Debt:seed-wb-external-debt.mjs': '35d TTL vs 30d cron (1.17×)',

  // ── Recovery cohort (annual data, infrequent crons) ──
  'Fiscal-Space:seed-recovery-fiscal-space.mjs': '35d TTL vs 30d cron (1.17×)',
  'Reserve-Adequacy:seed-recovery-reserve-adequacy.mjs': '35d TTL vs 30d cron (1.17×)',
  'External-Debt:seed-recovery-external-debt.mjs': '35d TTL vs 30d cron (1.17×)',
  'Reexport-Share:seed-recovery-reexport-share.mjs': '35d TTL vs 30d cron (1.17×)',
  'Sovereign-Wealth:seed-sovereign-wealth.mjs': '35d TTL vs 30d cron (1.17×)',

  // ── Climate (cont.) ──
  'Ocean-Ice:seed-climate-ocean-ice.mjs': '24h TTL vs 24h cron (1×)',

  // ── Energy ──
  'JODI-Gas:seed-jodi-gas.mjs': '35d TTL vs 35d cron (1×)',

  // ── Portwatch ──
  'PW-Disruptions:seed-portwatch-disruptions.mjs': '2h TTL vs 1h cron (2×) — borderline',
  'PW-Main:seed-portwatch.mjs': '12h TTL vs 6h cron (2×) — borderline',
  'PW-Chokepoints-Ref:seed-portwatch-chokepoints-ref.mjs': '7d TTL vs 7d cron (1×)',
  'Chokepoint-Baselines:seed-chokepoint-baselines.mjs': '400d TTL vs 400d cron (1×) — annual; canonical should outlive 3 cycles',

  // ── Other ──
  'USA-Spending:seed-usa-spending.mjs': '2h TTL vs 1h cron (2×) — borderline',
  'Submarine-Cables:seed-submarine-cables.mjs': '7d TTL vs 7d cron (1×)',
  'Displacement:seed-displacement-summary.mjs': '24h TTL vs 24h cron (1×)',
};

// Conventional bundle-level constants. Pre-seeded so `12 * HOUR` works
// without parsing the bundle's own declaration.
const PRESEEDED = {
  MIN: 60 * 1000,
  HOUR: 60 * 60 * 1000,
  DAY: 24 * 60 * 60 * 1000,
  WEEK: 7 * 24 * 60 * 60 * 1000,
};

/** Strip JS numeric-separator underscores so safe-eval can parse them. */
function stripNumericUnderscores(s) {
  // 7_200 → 7200, 86_400 → 86400. Only between digits, never adjacent.
  return s.replace(/(\d)_(?=\d)/g, '$1');
}

/**
 * Safely evaluate a simple numeric expression. Allows digits, +-/*(), and
 * underscored identifiers (which must be in `scope`). Rejects anything
 * else with null. No `eval` — uses Function constructor with a strict
 * input-character whitelist + name-substitution.
 */
function safeEval(expr, scope = {}) {
  const trimmed = stripNumericUnderscores(String(expr).trim());
  if (!/^[\w\s+\-*/().,_]+$/.test(trimmed)) return null;
  let substituted = trimmed;
  for (const [name, value] of Object.entries(scope)) {
    if (typeof value !== 'number') continue;
    substituted = substituted.replace(new RegExp(`\\b${name}\\b`, 'g'), `(${value})`);
  }
  if (!/^[\d\s+\-*/().]+$/.test(substituted)) return null;
  try {
    const result = Function(`"use strict"; return (${substituted})`)();
    return Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

/**
 * Find a `const|let|var|export const <name> = <expr>` declaration in `src`
 * and resolve to a number. Cycle-guarded.
 */
function resolveIdentifier(src, name, scope = {}, _seen = new Set()) {
  if (_seen.has(name)) return null;
  if (name in scope) return scope[name];
  if (name in PRESEEDED) return PRESEEDED[name];
  _seen.add(name);
  // Match: optional `export `, then `const|let|var <name> = <rhs>` up to ; // or newline
  const re = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*=\\s*([^;\\n]+?)(?:\\s*(?://|;)|$)`, 'm');
  const m = src.match(re);
  if (!m) return null;
  return resolveExpr(src, m[1].trim(), scope, _seen);
}

function resolveExpr(src, expr, scope = {}, _seen = new Set()) {
  const direct = safeEval(expr, { ...PRESEEDED, ...scope });
  if (direct != null) return direct;
  if (/^\w+$/.test(expr)) return resolveIdentifier(src, expr, scope, _seen);
  const idents = [...new Set([...expr.matchAll(/\b([A-Za-z_]\w*)\b/g)].map(m => m[1]))];
  const expanded = { ...scope, ...PRESEEDED };
  for (const id of idents) {
    if (id in expanded) continue;
    const v = resolveIdentifier(src, id, scope, _seen);
    if (v != null) expanded[id] = v;
  }
  return safeEval(expr, expanded);
}

function extractBundleSections(bundleSrc) {
  const sections = [];
  const blockRe = /\{\s*label:\s*'([^']+)'[\s\S]*?\}/g;
  for (const m of bundleSrc.matchAll(blockRe)) {
    const block = m[0];
    const label = m[1];
    const scriptM = block.match(/script:\s*'([^']+)'/);
    const intervalM = block.match(/intervalMs:\s*([^,}\n]+)/);
    if (!scriptM || !intervalM) continue;
    sections.push({ label, script: scriptM[1], intervalMsExpr: intervalM[1].trim() });
  }
  return sections;
}

function extractRunSeedTtl(seederSrc) {
  const m = seederSrc.match(/ttlSeconds:\s*([^,}\n]+)/);
  return m ? m[1].trim() : null;
}

// ── Tests ────────────────────────────────────────────────────────────────

test('every bundle section using runSeed has canonical TTL ≥ 3× cron interval', () => {
  const bundleFiles = readdirSync(SCRIPTS_DIR)
    .filter(f => f.startsWith('seed-bundle-') && f.endsWith('.mjs'))
    .map(f => join(SCRIPTS_DIR, f));
  assert.ok(bundleFiles.length > 0, 'no scripts/seed-bundle-*.mjs files found');

  const newViolations = [];     // (a) new violations not in allowlist → fail
  const resolvedAllowlistEntries = [];     // (b) allowlist entries no longer violating → fail
  const stillViolating = new Set();        // tracks which allowlist keys we observed violating
  const skipped = [];
  let checked = 0;

  for (const bundlePath of bundleFiles) {
    const bundleSrc = readFileSync(bundlePath, 'utf-8');
    const sections = extractBundleSections(bundleSrc);

    for (const sec of sections) {
      const intervalMs = resolveExpr(bundleSrc, sec.intervalMsExpr);
      if (intervalMs == null) {
        skipped.push(`${sec.label} (${sec.script}): unresolvable intervalMs="${sec.intervalMsExpr}"`);
        continue;
      }

      let seederSrc;
      try { seederSrc = readFileSync(join(SCRIPTS_DIR, sec.script), 'utf-8'); }
      catch { skipped.push(`${sec.label}: script file ${sec.script} not found`); continue; }

      const ttlExpr = extractRunSeedTtl(seederSrc);
      if (ttlExpr == null) {
        skipped.push(`${sec.label} (${sec.script}): no runSeed ttlSeconds — likely non-runSeed writer`);
        continue;
      }

      const ttlSeconds = resolveExpr(seederSrc, ttlExpr);
      if (ttlSeconds == null) {
        skipped.push(`${sec.label} (${sec.script}): ttlSeconds expr "${ttlExpr}" unresolvable — resolver gap (extending the test)`);
        continue;
      }

      checked++;
      const ttlMs = ttlSeconds * 1000;
      const required = SAFETY_FACTOR * intervalMs;
      const allowKey = `${sec.label}:${sec.script}`;

      if (ttlMs < required) {
        const ttlH = (ttlMs / 1000 / 3600).toFixed(1);
        const intH = (intervalMs / 1000 / 3600).toFixed(1);
        const ratio = (ttlMs / intervalMs).toFixed(2);
        if (allowKey in KNOWN_VIOLATIONS) {
          stillViolating.add(allowKey);
        } else {
          newViolations.push(
            `${allowKey}: TTL ${ttlH}h vs cron ${intH}h — ratio ${ratio}× < ${SAFETY_FACTOR}× required. ` +
            `Bump ttlSeconds to ≥ ${required / 1000}s (${(required / 1000 / 3600).toFixed(1)}h), or add to KNOWN_VIOLATIONS with justification.`,
          );
        }
      }
    }
  }

  // Allowlist hygiene: any KNOWN_VIOLATIONS entry not still violating means
  // the seeder was fixed but the entry wasn't removed — the allowlist drifts.
  for (const allowKey of Object.keys(KNOWN_VIOLATIONS)) {
    if (!stillViolating.has(allowKey)) {
      resolvedAllowlistEntries.push(
        `${allowKey} is in KNOWN_VIOLATIONS but is NO LONGER violating (or no longer detected). ` +
        `Remove it from the allowlist in ${__filename.split('/').pop()}.`,
      );
    }
  }

  if (skipped.length > 0) console.log(`[ttl-vs-cron] skipped ${skipped.length} section(s):\n  - ${skipped.join('\n  - ')}`);

  assert.ok(checked > 0, 'no bundle sections checked — resolver may be broken');
  assert.deepEqual(newViolations, [],
    `${newViolations.length} NEW canonical-TTL-vs-cron-interval violation(s) found:\n  - ${newViolations.join('\n  - ')}\n\n` +
    `Per memory \`seed-meta-populated-canonical-missing-ttl-cron-match\`: when canonical TTL ≈ cron interval, ` +
    `any drift leaves the canonical TTL'd-out while seed-meta survives — /api/health reports EMPTY records=0 with no diagnostic trail.`,
  );
  assert.deepEqual(resolvedAllowlistEntries, [],
    `${resolvedAllowlistEntries.length} KNOWN_VIOLATIONS entry/entries are stale:\n  - ${resolvedAllowlistEntries.join('\n  - ')}`,
  );
});

// ── Sanity tests for the resolver itself ─────────────────────────────────

test('resolver: numeric literal', () => {
  assert.equal(resolveExpr('', '43200'), 43200);
});

test('resolver: numeric literal with underscores (7_200, 86_400)', () => {
  assert.equal(resolveExpr('', '7_200'), 7200);
  assert.equal(resolveExpr('', '86_400'), 86400);
});

test('resolver: simple multiplication', () => {
  assert.equal(resolveExpr('', '35 * 24 * 3600'), 35 * 24 * 3600);
});

test('resolver: preseeded HOUR/DAY/WEEK constants', () => {
  assert.equal(resolveExpr('', '12 * HOUR'), 12 * 3600 * 1000);
  assert.equal(resolveExpr('', '7 * DAY'), 7 * 24 * 3600 * 1000);
  assert.equal(resolveExpr('', 'WEEK'), 7 * 24 * 3600 * 1000);
});

test('resolver: const declared in src (with underscored numeric)', () => {
  const src = 'const TTL_SECONDS = 86_400;\n';
  assert.equal(resolveExpr(src, 'TTL_SECONDS'), 86400);
});

test('resolver: export const declared in src', () => {
  const src = 'export const CACHE_TTL_SECONDS = 2700;\n';
  assert.equal(resolveExpr(src, 'CACHE_TTL_SECONDS'), 2700);
});

test('resolver: const expression mixing identifiers + arithmetic', () => {
  const src = 'const TTL = 35 * 24 * 3600;\n';
  assert.equal(resolveExpr(src, 'TTL'), 35 * 24 * 3600);
});

test('resolver: returns null on unresolvable identifier', () => {
  assert.equal(resolveExpr('', 'COMPLETELY_UNKNOWN'), null);
});

test('resolver: rejects unsafe input', () => {
  assert.equal(resolveExpr('', 'process.env.X'), null);
  assert.equal(resolveExpr('', 'someFunction()'), null);
});

test('extractBundleSections: catches sections with intervalMs', () => {
  const sample = `
const HOUR = 60 * 60 * 1000;
export const SECTIONS = [
  { label: 'A', script: 'seed-a.mjs', intervalMs: HOUR, timeoutMs: 120_000 },
  { label: 'B', script: 'seed-b.mjs', canonicalKey: 'foo', intervalMs: 12 * HOUR, timeoutMs: 300_000 },
];
`;
  const sections = extractBundleSections(sample);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].label, 'A');
  assert.equal(sections[1].intervalMsExpr, '12 * HOUR');
});
