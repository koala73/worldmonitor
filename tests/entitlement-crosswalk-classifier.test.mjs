import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SITE_MAP, classify } from '../scripts/generate-entitlement-crosswalk.mjs';

// The crosswalk's checksum (`unmappedGates: 0`) is only worth something if an
// unclassified gate can actually reach it. The first version keyed code sites on
// FILENAME ALONE, so any new gate landing in an already-mapped file inherited
// that file's capability and the checksum stayed green — a synthetic
// `hasPremiumAccess()` gate added to `src/App.ts` was silently absorbed into
// `limits.panels`.
//
// Identity is now (file, predicate kind), and every SITE_MAP entry that matches
// real gates carries a `preds` allow-list. These tests pin that property: they
// must fail if site identity is ever widened back to the filename.

const site = (file, pred) => ({ source: 'site', rule: `site:${file}:1`, file, pred });

describe('entitlement crosswalk classifier', () => {
  it('maps a known file with its known predicate', () => {
    // convex/alertRules.ts gates on `tier` and is mapped to alerts.rules.
    const v = classify(site('convex/alertRules.ts', 'tier'));
    assert.ok(v, 'alertRules.ts/tier should classify');
    assert.equal(v.cap, 'alerts.rules');
  });

  it('does NOT map a different predicate kind in that same file', () => {
    // The regression: a NEW gate of another kind must not inherit alerts.rules.
    const v = classify(site('convex/alertRules.ts', 'apiAccess'));
    assert.equal(v, null, 'a different predicate in a mapped file must stay unmapped');
  });

  it('does NOT map a gate in a file nobody classified', () => {
    const v = classify(site('src/services/__not-a-real-file.ts', 'hasPremiumAccess'));
    assert.equal(v, null, 'an unmapped file must stay unmapped');
  });

  it('does NOT map src/App.ts, which carries no gate today', () => {
    // App.ts was previously swept into the panels entry by a broad alternation,
    // purely because it MENTIONS hasPremiumAccess() in a comment. If a real gate
    // is ever added there it must be classified deliberately, not inherited.
    const v = classify(site('src/App.ts', 'hasPremiumAccess'));
    assert.equal(v, null, 'src/App.ts must not be pre-claimed by a broad pattern');
  });

  it('every SITE_MAP entry resolves to a capability or a documented exclusion', () => {
    for (const [re, v] of SITE_MAP) {
      const kind = v.cap ? 'cap' : v.exclude ? 'exclude' : null;
      assert.ok(kind, `SITE_MAP entry ${re} must set either cap or exclude`);
      if (v.exclude) {
        assert.ok(
          typeof v.exclude === 'string' && v.exclude.length > 20,
          `exclusion for ${re} needs a real reason, not a placeholder`,
        );
      }
    }
  });

  it('a preds allow-list never contains an unknown predicate kind', () => {
    const KNOWN = new Set([
      'tier', 'hasPremiumAccess', 'isProUser', 'apiAccess',
      'mcpAccess', 'dataExport', 'isCallerPremium', 'requiresPremium', 'other',
    ]);
    for (const [re, v] of SITE_MAP) {
      for (const p of v.preds ?? []) {
        assert.ok(KNOWN.has(p), `SITE_MAP ${re} lists unknown predicate "${p}"`);
      }
    }
  });
});
