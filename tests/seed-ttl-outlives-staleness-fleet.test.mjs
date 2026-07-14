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
  // seed-fire-detections (canonical + its wildfire dashboard projection, which inherits
  // the same TTL). FROZEN ON PURPOSE — and NOT for the reason you would guess.
  //
  // Satisfying the invariant here means raising ttlSeconds above the 6h gate, and that
  // DOWNGRADES A SAFETY ALARM. Verified against classifyKey with the seeder dead 3h:
  //
  //   ttl 2h (today): wildfires -> EMPTY (crit)   — ops is paged the moment the panel blanks
  //   ttl 7h:         wildfires -> OK    (green)  — 3h-old fire data served, silently
  //   ttl 7h, 6.5h:   wildfires -> STALE_SEED (warn)  — the crit becomes a warn
  //
  // The canonical `wildfires` is NOT in EMPTY_DATA_OK_KEYS, so its 2h expiry is precisely
  // what makes a dead fire feed loud. Nor can the gate be tightened instead: 360 is sized
  // to FIRMS NRT (resets midnight UTC, new-day data takes 3-6h), and with no zeroIsValid a
  // zero-fire run takes the RETRY path and does not advance seed-meta.fetchedAt — a tighter
  // gate would alarm every night.
  //
  // The REAL defect is underneath and is tracked separately: wildfiresBootstrap is in
  // EMPTY_DATA_OK_KEYS, so an ABSENT key + still-fresh seed-meta classifies as OK. In the
  // very scenario its separate registration exists for (health.js:342 — "monitor it so
  // canonical fallback cannot hide transform/write failures"), the panel is blank and the
  // projection reports GREEN. Today the canonical's crit masks that; fixing the TTL would
  // remove the mask AND the alarm.
  'seed-fire-detections.mjs',
  'seed-fire-detections.mjs::seed-meta:wildfire:fires-bootstrap',
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
    const key = m[1];
    const gate = Number(m[2].replace(/_/g, ''));
    // A seed-meta key can be registered under more than one health name (7 are today).
    // Take the LARGEST gate: that is the binding constraint for "the data must outlive
    // the gate", so a future divergence cannot silently pick the laxer one.
    gates[key] = Math.max(gates[key] ?? 0, gate);
  }
  // Coverage must not rot silently. The regex needs `key: '…', maxStaleMin: <digits>`
  // adjacent, so a constant, a reordered field, or an interposed property would be
  // skipped WITHOUT failing — and a gate we cannot see is a gate we cannot enforce.
  // Compare against UNIQUE declared keys, not raw occurrences (those 7 duplicates).
  const declared = new Set([...health.matchAll(/key:\s*'(seed-meta:[^']+)'/g)].map((m) => m[1])).size;
  return { gates, parsed: Object.keys(gates).length, declared };
}

// Walk backwards to the `{` that ENCLOSES idx at depth 0, stepping over nested literals.
function enclosingObjectStart(src, idx) {
  let depth = 0;
  for (let i = idx - 1; i >= 0; i -= 1) {
    const c = src[i];
    if (c === '}') depth += 1;
    else if (c === '{') {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return 0;
}

function auditSeeders() {
  const { gates } = readHealthStalenessGates();
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
      // Brace-BALANCED: a nested literal before metaKey (e.g. `transform: (d) => ({…})`)
      // would make a naive lastIndexOf('{') open the window inside that nested object and
      // pick up ITS ttl. Correct for all extraKeys today, fragile in principle — so don't
      // rely on the shape.
      const objSrc = src.slice(enclosingObjectStart(src, m.index), m.index).replace(/\/\/[^\n]*/g, '');
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

test('every health staleness gate is actually parsed — coverage cannot rot', () => {
  // A gate the extractor cannot see is a gate it cannot enforce, and it fails SILENTLY.
  const { parsed, declared } = readHealthStalenessGates();
  assert.equal(parsed, declared, `parsed ${parsed} of ${declared} seed-meta gates in health.js — the rest are silently unguarded`);
});
