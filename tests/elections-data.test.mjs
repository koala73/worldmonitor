/**
 * Election data integrity tests — PR #221
 *
 * Validates the corrections made to elections.ts against IFES / official
 * electoral-commission sources.  All assertions are data-level checks that
 * parse the TypeScript source directly (the same pattern used by
 * deploy-config.test.mjs) so no build step is required.
 *
 * Run:  node --test tests/elections-data.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(__dirname, '../src/config/elections.ts'), 'utf-8');

// ---------------------------------------------------------------------------
// Helpers — extract structured election objects from the TS source
// ---------------------------------------------------------------------------

/**
 * Regex-extract every election entry from the ELECTIONS_2026_2027 array.
 * Returns an array of { country, countryCode, type, dateStr, significance, notes }.
 */
function parseElections() {
  const entries = [];
  // Match each object literal { ... } inside the exported array.
  // We use a simple state-machine rather than a full parser because the
  // file structure is predictable (flat array of object literals).
  const blockRe = /\{\s*country:\s*'([^']+)',\s*countryCode:\s*'([^']+)',\s*type:\s*'([^']+)',\s*date:\s*new Date\('([^']+)'\),\s*significance:\s*'([^']+)',\s*notes:\s*'([^']*(?:\\.[^']*)*)'/gs;
  // The notes field may use escaped quotes; the capture is generous.
  let m;
  while ((m = blockRe.exec(source)) !== null) {
    entries.push({
      country: m[1],
      countryCode: m[2],
      type: m[3],
      dateStr: m[4],
      significance: m[5],
      notes: m[6],
    });
  }
  return entries;
}

const elections = parseElections();

/** Find all entries for a given country code */
function findByCode(code) {
  return elections.filter(e => e.countryCode === code);
}

/** Find the single entry for a code (asserts exactly one) */
function findOne(code) {
  const results = findByCode(code);
  assert.equal(results.length, 1, `Expected exactly 1 entry for ${code}, found ${results.length}`);
  return results[0];
}

// ---------------------------------------------------------------------------
// Sanity — parser found a reasonable number of entries
// ---------------------------------------------------------------------------
describe('elections.ts parser sanity', () => {
  it('extracts a non-trivial number of election entries', () => {
    assert.ok(elections.length >= 10, `Expected >=10 elections, got ${elections.length}`);
  });

  it('every entry has a valid ISO date string', () => {
    for (const e of elections) {
      const d = new Date(e.dateStr);
      assert.ok(!isNaN(d.getTime()), `Invalid date "${e.dateStr}" for ${e.country}`);
    }
  });

  it('every entry has an allowed election type', () => {
    const allowed = new Set(['presidential', 'parliamentary', 'referendum', 'local', 'legislative']);
    for (const e of elections) {
      assert.ok(allowed.has(e.type), `Unknown type "${e.type}" for ${e.country}`);
    }
  });

  it('every entry has an allowed significance level', () => {
    const allowed = new Set(['high', 'medium', 'low']);
    for (const e of elections) {
      assert.ok(allowed.has(e.significance), `Unknown significance "${e.significance}" for ${e.country}`);
    }
  });
});

// ---------------------------------------------------------------------------
// P1 — Tier-1 CII-critical corrections
// ---------------------------------------------------------------------------
describe('P1 — Tier-1 blocking corrections', () => {
  it('GB (United Kingdom) is set to 2029-08-15, not 2027', () => {
    const gb = findOne('GB');
    assert.equal(gb.dateStr, '2029-08-15', 'UK election date should be 2029-08-15');
    assert.equal(gb.type, 'parliamentary');
    assert.equal(gb.significance, 'high');
    assert.ok(
      gb.notes.includes('no later than 15 August 2029'),
      'Notes should cite UK Electoral Commission deadline',
    );
  });

  it('GB election is NOT in 2027 (would trigger early CII boost)', () => {
    const gb = findOne('GB');
    assert.ok(
      !gb.dateStr.startsWith('2027'),
      'GB must not be in 2027 — no evidence supports an early election',
    );
  });

  it('IR (Iran) legislative is set to 2028, not 2027', () => {
    const ir = findOne('IR');
    assert.equal(ir.dateStr, '2028-03-01', 'Iran Majlis election should be 2028-03-01');
    assert.equal(ir.type, 'legislative');
    assert.ok(
      ir.notes.includes('4-year term from 2024'),
      'Notes should cite Art. 63 / 4-year term from 2024',
    );
  });
});

// ---------------------------------------------------------------------------
// P2 — Data corrections (lower CII impact)
// ---------------------------------------------------------------------------
describe('P2 — data corrections', () => {
  it('AU (Australia) is moved to 2028, not 2026', () => {
    const au = findOne('AU');
    assert.ok(
      au.dateStr.startsWith('2028'),
      `Australia should be in 2028, got ${au.dateStr}`,
    );
    assert.equal(au.type, 'parliamentary');
    assert.ok(
      au.notes.includes('2027') && au.notes.includes('2028'),
      'Notes should reference APH Library 2027–2028 window',
    );
  });

  it('JP (Japan) snap/upper-house entry is removed', () => {
    const jp = findByCode('JP');
    assert.equal(jp.length, 0, 'Japan should have no active election entries');
    // verify removal comment exists
    assert.ok(
      source.includes('Japan 2026-07-25 removed'),
      'Source should contain a removal comment for Japan',
    );
  });

  it('GE (Georgia) direct presidential entry is removed', () => {
    const ge = findByCode('GE');
    assert.equal(ge.length, 0, 'Georgia should have no active election entries');
    assert.ok(
      source.includes('Georgia 2026-10-26 removed'),
      'Source should contain a removal comment for Georgia',
    );
  });

  it('RW (Rwanda) is moved to 2029, not 2027', () => {
    const rw = findOne('RW');
    assert.equal(rw.dateStr, '2029-07-15', 'Rwanda should be 2029-07-15');
    assert.equal(rw.type, 'presidential');
    assert.ok(
      rw.notes.includes('5-year term from 2024'),
      'Notes should cite 5-year term from 2024 IFES',
    );
  });

  it('CZ (Czech Republic) is typed as local (Senate renewal), not parliamentary', () => {
    const cz = findOne('CZ');
    assert.equal(cz.type, 'local', 'Czech event should be local (Senate 1/3 renewal)');
    assert.equal(cz.significance, 'low', 'Senate partial renewal should be low significance');
    assert.ok(
      cz.notes.includes('Senate') && cz.notes.includes('1/3'),
      'Notes should mention Senate 1/3 renewal',
    );
  });

  it('KZ (Kazakhstan) is typed as referendum, not parliamentary', () => {
    const kz = findOne('KZ');
    assert.equal(kz.type, 'referendum', 'Kazakhstan should be a referendum');
    assert.equal(kz.dateStr, '2026-03-15', 'Kazakhstan referendum date should be March 15');
    assert.ok(
      kz.notes.includes('Constitutional referendum'),
      'Notes should describe constitutional referendum',
    );
  });
});

// ---------------------------------------------------------------------------
// Removed entries — confirm stale data no longer exists
// ---------------------------------------------------------------------------
describe('removed / off-cycle elections do not exist', () => {
  it('no Iran presidential 2026 entry exists', () => {
    const ir = findByCode('IR');
    for (const e of ir) {
      assert.notEqual(e.type, 'presidential', 'Iran presidential 2026 should be removed');
      assert.ok(!e.dateStr.startsWith('2026'), 'Iran should have no 2026 entry');
    }
  });

  it('no Mexico 2026 entry exists', () => {
    assert.equal(findByCode('MX').length, 0, 'Mexico 2026 should be removed');
  });

  it('no Philippines 2026 entry exists', () => {
    assert.equal(findByCode('PH').length, 0, 'Philippines 2026 should be removed');
  });
});

// ---------------------------------------------------------------------------
// Tier-1 countries — sanity-check that existing correct entries are intact
// ---------------------------------------------------------------------------
describe('existing Tier-1 entries remain correct', () => {
  it('US midterms 2026-11-03 unchanged', () => {
    const us = findOne('US');
    assert.equal(us.dateStr, '2026-11-03');
    assert.equal(us.type, 'legislative');
    assert.equal(us.significance, 'high');
  });

  it('FR presidential first round 2027-04-23 unchanged', () => {
    const fr = findByCode('FR');
    assert.ok(fr.length >= 2, 'France should have first round + runoff');
    const r1 = fr.find(e => e.dateStr === '2027-04-23');
    assert.ok(r1, 'France first round should be 2027-04-23');
    assert.equal(r1.type, 'presidential');
    assert.equal(r1.significance, 'high');
  });

  it('FR presidential runoff 2027-05-07 unchanged', () => {
    const fr = findByCode('FR');
    const r2 = fr.find(e => e.dateStr === '2027-05-07');
    assert.ok(r2, 'France runoff should be 2027-05-07');
  });

  it('DE federal election 2029-02-23 unchanged', () => {
    const de = findOne('DE');
    assert.equal(de.dateStr, '2029-02-23');
    assert.equal(de.type, 'parliamentary');
    assert.equal(de.significance, 'high');
  });

  it('BR presidential 2026-10-04 unchanged', () => {
    const br = findOne('BR');
    assert.equal(br.dateStr, '2026-10-04');
    assert.equal(br.type, 'presidential');
    assert.equal(br.significance, 'high');
  });

  it('IN general election 2029-05-01 unchanged', () => {
    const ind = findOne('IN');
    assert.equal(ind.dateStr, '2029-05-01');
    assert.equal(ind.type, 'parliamentary');
    assert.equal(ind.significance, 'high');
  });
});

// ---------------------------------------------------------------------------
// CII boost guardrails — no Tier-1 country triggers a boost before its date
// ---------------------------------------------------------------------------
describe('CII boost guardrails — no premature Tier-1 boosts', () => {
  const tier1Codes = ['US', 'GB', 'FR', 'DE', 'IN', 'BR'];

  it('no Tier-1 election has already passed today (2026-02-26)', () => {
    const today = new Date('2026-02-26');
    for (const code of tier1Codes) {
      for (const e of findByCode(code)) {
        const d = new Date(e.dateStr);
        assert.ok(
          d >= today,
          `${e.country} (${code}) election ${e.dateStr} is in the past`,
        );
      }
    }
  });

  it('GB election boost will not fire before mid-2029 (60-day window)', () => {
    const gb = findOne('GB');
    const boostStart = new Date(gb.dateStr);
    boostStart.setDate(boostStart.getDate() - 60);
    // Boost window should start no earlier than mid-June 2029
    assert.ok(
      boostStart.getFullYear() >= 2029,
      `GB boost window starts in ${boostStart.toISOString()} — should be 2029+`,
    );
  });

  it('IR election boost will not fire before early 2028 (60-day window)', () => {
    const ir = findOne('IR');
    const boostStart = new Date(ir.dateStr);
    boostStart.setDate(boostStart.getDate() - 60);
    assert.ok(
      boostStart.getFullYear() >= 2027,
      `IR boost window starts in ${boostStart.toISOString()} — should be late 2027+`,
    );
  });
});

// ---------------------------------------------------------------------------
// Tentative / speculative entries must be annotated
// ---------------------------------------------------------------------------
describe('tentative entries have proper notes', () => {
  const tentativeCodes = ['GB', 'AU', 'RW', 'IR'];

  it('all tentative entries include "Tentative" in notes', () => {
    for (const code of tentativeCodes) {
      const entries = findByCode(code);
      for (const e of entries) {
        assert.ok(
          e.notes.toLowerCase().includes('tentative'),
          `${e.country} (${code}) is speculative but notes lack "Tentative": "${e.notes}"`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Structural constraints
// ---------------------------------------------------------------------------
describe('structural data quality', () => {
  it('country codes are all 2-letter uppercase', () => {
    for (const e of elections) {
      assert.match(e.countryCode, /^[A-Z]{2}$/, `Invalid code "${e.countryCode}" for ${e.country}`);
    }
  });

  it('no duplicate (countryCode + dateStr) pairs', () => {
    const keys = elections.map(e => `${e.countryCode}:${e.dateStr}`);
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    assert.deepStrictEqual(dupes, [], `Duplicate election entries: ${dupes.join(', ')}`);
  });

  it('dates are in chronological order within each country', () => {
    const byCc = {};
    for (const e of elections) {
      (byCc[e.countryCode] ??= []).push(e.dateStr);
    }
    for (const [cc, dates] of Object.entries(byCc)) {
      const sorted = [...dates].sort();
      assert.deepStrictEqual(dates, sorted, `${cc} elections are not in chronological order`);
    }
  });

  it('no election is scheduled before 2026 or after 2035', () => {
    for (const e of elections) {
      const year = new Date(e.dateStr).getUTCFullYear();
      assert.ok(year >= 2026 && year <= 2035, `${e.country} date ${e.dateStr} is outside 2026-2035`);
    }
  });
});
