// FLEET GUARD: a seeded key's data TTL should OUTLIVE its own health staleness gate.
//
// Why this exists (#5309): seed-conflict-intel ran on `*/15 * * * *` and wrote its
// data key with a 900s (15-minute) TTL — a TTL exactly equal to the refresh interval.
// One Railway-SKIPPED tick (11 skipped in a 12h window) and the data was gone: health
// reported EMPTY (crit) while the seeder had actually SUCCEEDED minutes earlier, and
// consumers of the forecast EMA input got nothing.
//
// The invariant, stated precisely:
//
//   ttlSeconds  >  maxStaleMin * 60
//
// so the escalation is ordered and truthful —
//   seeder late  -> STALE_SEED (warn, data still served)
//   seeder dead  -> EMPTY      (crit, data genuinely gone)
//
// Without it a seeder that is merely LATE reports as a CRIT, because the data
// evaporated before health was even willing to call the seeder stale.
//
// ── Why there is an allowlist, and what it does and does not mean ──────────────
//
// 51 seeders currently violate this. They are NOT all broken. `maxStaleMin` is only
// a PROXY for the cron cadence, and it is a leaky one: several of these have TTLs
// that are 4-6x their ACTUAL refresh interval and are in no danger of losing data —
// they simply have a generous maxStaleMin. Verified against the live Railway crons:
//
//   seed-commodity-quotes   cron */5    ttl 30min  = 6x interval  (safe)
//   seed-economy            cron */15   ttl 60min  = 4x interval  (safe)
//   seed-thermal-escalation cron 0 */3  ttl 9h     = 3x interval  (retired this PR)
//   seed-conflict-intel     cron */15   ttl 15min  = 1x interval  (THE BUG, fixed)
//
// So raising all 51 TTLs would trade real cost (memory, staler data served) for a
// cosmetic severity signal. Instead this test RATCHETS: the existing violations are
// frozen as visible debt, and no NEW one can be introduced. Adding a seeder here is
// a deliberate act that shows up in review.
//
// To retire an entry: raise its ttlSeconds above maxStaleMin*60 and delete the line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

// Known violations, frozen. Shrink this list; never grow it without a reason in review.
const KNOWN_VIOLATIONS = new Set([
  'seed-aaii-sentiment.mjs',
  'seed-bis-data.mjs',
  'seed-china-coverage-health.mjs',
  'seed-chokepoint-baselines.mjs',
  'seed-climate-news.mjs',
  'seed-climate-ocean-ice.mjs',
  'seed-co2-monitoring.mjs',
  'seed-commodity-quotes.mjs',
  'seed-cot.mjs',
  'seed-cross-source-signals.mjs',
  'seed-crypto-sectors.mjs',
  'seed-cyber-threats.mjs',
  'seed-displacement-summary.mjs',
  'seed-ecb-fx-rates.mjs',
  'seed-economy.mjs',
  'seed-energy-crisis-policies.mjs',
  'seed-eurostat-country-data.mjs',
  'seed-eurostat-gov-debt-q.mjs',
  'seed-eurostat-house-prices.mjs',
  'seed-eurostat-industrial-production.mjs',
  'seed-fire-detections.mjs',
  // extraKey. The wildfire dashboard projection is a panel PRIMARY source
  // (api/bootstrap.js) and expires at 2h while health tolerates 6h of lateness — and
  // wildfiresBootstrap sits in the tolerate-as-STALE_SEED list, so a dead fire feed can
  // leave the panel with NO data while health reports only a warn.
  // Deliberately not "fixed" here: the cron is */30, so a 2h TTL is 4x the interval and
  // carries no data-loss risk in normal operation. The real defect is a 6h staleness gate
  // (12x the cadence) on a safety-relevant feed — tightening that changes alerting
  // sensitivity and is a human decision, not a mechanical TTL bump.
  'seed-fire-detections.mjs::seed-meta:wildfire:fires-bootstrap',
  'seed-fsi-eu.mjs',
  'seed-fx-rates.mjs',
  'seed-fx-yoy.mjs',
  'seed-global-tenders.mjs',
  'seed-gold-cb-reserves.mjs',
  'seed-gold-etf-flows.mjs',
  'seed-hormuz.mjs',
  'seed-iea-oil-stocks.mjs',
  'seed-imf-external.mjs',
  'seed-imf-growth.mjs',
  'seed-imf-labor.mjs',
  'seed-imf-macro.mjs',
  'seed-iran-events.mjs',
  'seed-jodi-gas.mjs',
  'seed-market-quotes.mjs',
  'seed-portwatch-chokepoints-ref.mjs',
  'seed-portwatch-disruptions.mjs',
  'seed-portwatch.mjs',
  'seed-recovery-external-debt.mjs',
  'seed-recovery-fiscal-space.mjs',
  'seed-recovery-reserve-adequacy.mjs',
  'seed-research.mjs',
  'seed-sovereign-wealth.mjs',
  'seed-spr-policies.mjs',
  'seed-submarine-cables.mjs',
  'seed-token-panels.mjs',
  'seed-usa-spending.mjs',
  'seed-wb-external-debt.mjs',
  'seed-weather-alerts.mjs',
  'seed-yield-curve-eu.mjs',
]);

// Resolve `ttlSeconds: X` / `maxStaleMin: Y` where the value is a literal, a simple
// arithmetic expression, or a `const` defined in the same file.
function resolveValue(expr, src, depth = 0) {
  if (depth > 5) return Number.NaN;
  const e = expr.split('//')[0].trim().replace(/[;,]$/, '').trim();
  if (/^[\d\s*+/()._-]+$/.test(e)) {
    try { return Function(`"use strict";return (${e.replace(/_/g, '')})`)(); } catch { return Number.NaN; }
  }
  if (!/^[A-Za-z_$][\w$]*$/.test(e)) return Number.NaN;   // not a bare identifier
  const m = src.match(new RegExp(`const\\s+${e}\\s*=\\s*([^;\\n]+)`));
  return m ? resolveValue(m[1], src, depth + 1) : Number.NaN;
}

// health.js is the source of truth for a key's staleness gate: metaKey -> maxStaleMin.
// An extraKey's gate is NOT the seeder's own canonical maxStaleMin — it is whatever
// health registered for that projection's metaKey, which is frequently different.
function readHealthStalenessGates() {
  const health = readFileSync(join(SCRIPTS, '..', 'api', 'health.js'), 'utf8');
  const gates = {};
  for (const m of health.matchAll(/key:\s*'(seed-meta:[^']+)'\s*,\s*maxStaleMin:\s*([\d_]+)/g)) {
    gates[m[1]] = Number(m[2].replace(/_/g, ''));
  }
  return gates;
}

function auditSeeders() {
  const gates = readHealthStalenessGates();
  const violations = [];
  const audited = [];
  for (const file of readdirSync(SCRIPTS).filter((f) => /^seed-.*\.mjs$/.test(f))) {
    const src = readFileSync(join(SCRIPTS, file), 'utf8');
    // Match option lines, not arbitrary prose. Several seeders explain health
    // thresholds in comments before their runSeed config; a broad search would
    // read the comment and silently skip the seeder when it is not parseable.
    const ttlM = src.match(/^\s*ttlSeconds:\s*([^,\n]+)/m);
    const staleM = src.match(/^\s*maxStaleMin:\s*([^,\n]+)/m);

    // (a) the canonical key
    if (ttlM && staleM) {
      const ttl = resolveValue(ttlM[1], src);
      const maxStaleMin = resolveValue(staleM[1], src);
      if (Number.isFinite(ttl) && Number.isFinite(maxStaleMin)) {
        audited.push(file);
        if (ttl <= maxStaleMin * 60) violations.push({ file, ttl, maxStaleMin });
      }
    }

    // (b) each health-monitored extraKey (side-write). These carry their OWN ttl and
    // their OWN metaKey, and several are a dashboard panel's PRIMARY source
    // (api/bootstrap.js) — so an expired projection blanks the panel even while the
    // canonical key is alive. runSeed resolves an extraKey's TTL as `ek.ttl || ttlSeconds`
    // (scripts/_seed-utils.mjs), so one that declares no ttl INHERITS the canonical's.
    for (const m of src.matchAll(/^\s*metaKey:\s*'(seed-meta:[^']+)'/gm)) {
      const gate = gates[m[1]];
      if (gate === undefined) continue;                  // not health-monitored
      // Scope to THIS extraKey's object literal, so a sibling's ttl is never
      // misattributed, and strip comments so prose cannot be read as config.
      const objSrc = src.slice(src.lastIndexOf('{', m.index), m.index).replace(/\/\/[^\n]*/g, '');
      const ownTtl = [...objSrc.matchAll(/\bttl(?:Seconds)?:\s*([^,\n}]+)/g)].pop();
      const ttlExpr = ownTtl ? ownTtl[1] : (ttlM ? ttlM[1] : null);   // ek.ttl || ttlSeconds
      if (!ttlExpr) continue;
      const ttl = resolveValue(ttlExpr, src);
      if (!Number.isFinite(ttl)) continue;
      const id = `${file}::${m[1]}`;
      audited.push(id);
      if (ttl <= gate * 60) violations.push({ file: id, ttl, maxStaleMin: gate });
    }
  }
  return { audited, violations };
}

test('no NEW seeder lets its data expire before its own staleness gate', () => {
  const { audited, violations } = auditSeeders();

  // Guard the guard: a broken extractor would silently audit nothing and pass. This
  // is exactly how the first draft of this audit fooled me — it resolved 4 of ~120
  // seeders and reported "3 violations" with a straight face.
  assert.ok(audited.length > 80, `extractor regressed: only audited ${audited.length} seeders`);

  const fresh = violations.filter((v) => !KNOWN_VIOLATIONS.has(v.file));
  assert.deepEqual(
    fresh.map((v) => `${v.file} (ttl=${v.ttl}s <= maxStaleMin=${v.maxStaleMin}min)`),
    [],
    'a seeded key must outlive its staleness gate, or a merely-late seeder reports as an EMPTY crit',
  );
});

test('the audit reads config options rather than prose comments', () => {
  const { audited } = auditSeeders();
  assert.ok(
    audited.includes('seed-aviation.mjs'),
    'seed-aviation documents another health threshold before its runSeed options',
  );
});

test('the allowlist does not rot — every frozen entry is still a real violation', () => {
  // When someone fixes a seeder's TTL, its allowlist line must go. Otherwise the list
  // grows stale, hides real debt, and quietly loses its meaning.
  const { violations } = auditSeeders();
  const actual = new Set(violations.map((v) => v.file));
  const retired = [...KNOWN_VIOLATIONS].filter((f) => !actual.has(f));
  assert.deepEqual(retired, [], 'these seeders now satisfy the invariant — delete them from KNOWN_VIOLATIONS');
});
