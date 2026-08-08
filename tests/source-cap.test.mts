import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeRolloutLegacyDisabledStates,
  computeCapDisabledSources,
  selectSourcesUnderCap,
  findFullyDisabledCategories,
} from '../src/services/source-cap';

const F = (...names: string[]) => names.map((name) => ({ name }));

describe('computeCapDisabledSources: legacy migration fingerprint', () => {
  it('reconstructs the exact mixed default-plus-cap disabled set', () => {
    const defaultDisabled = new Set(['a2']);
    const result = computeCapDisabledSources(
      { a: F('a1', 'a2'), b: F('b1', 'b2') },
      [],
      defaultDisabled,
      2,
    );
    assert.deepEqual([...result].sort(), ['a2', 'b2']);
  });
});

describe('computeRolloutLegacyDisabledStates: exact release-path fingerprints', () => {
  it('enumerates untouched default and every chronological cap path without mutating inputs', () => {
    const feeds = {
      a: F('base-a', 'stage-1'),
      b: F('base-b', 'stage-2'),
      c: F('base-disabled'),
    };
    const initial = new Set(['base-disabled']);
    const stages = [
      { introducedNames: new Set(['stage-1']), protectedNames: new Set(['stage-1']) },
      { introducedNames: new Set(['stage-2']), protectedNames: new Set(['stage-1', 'stage-2']) },
    ];

    const states = computeRolloutLegacyDisabledStates(
      feeds,
      [],
      initial,
      2,
      new Set(),
      stages,
    );
    const canonical = new Set(states.map((state) => [...state].sort().join('|')));

    assert.ok(canonical.has('base-disabled'), 'a profile that stayed Pro/default-only must be recognized');
    assert.ok(
      canonical.has('base-b|base-disabled'),
      'a profile capped after stage 1 must retain the exact auto-disabled base source',
    );
    assert.ok(
      canonical.has('base-a|base-b|base-disabled'),
      'a profile capped after both protected rollout stages must be recognized',
    );
    assert.equal(canonical.size, states.length, 'equivalent release paths must be deduplicated');
    assert.deepEqual(initial, new Set(['base-disabled']), 'initial disabled state must not be mutated');
  });

  it('rejects rollout names that are introduced by more than one stage', () => {
    assert.throws(
      () => computeRolloutLegacyDisabledStates(
        { a: F('base', 'duplicate') },
        [],
        new Set(),
        1,
        new Set(),
        [
          { introducedNames: new Set(['duplicate']), protectedNames: new Set() },
          { introducedNames: new Set(['duplicate']), protectedNames: new Set() },
        ],
      ),
      /introduced by more than one rollout stage/,
    );
  });
});

describe('selectSourcesUnderCap: round-robin per-category fairness', () => {
  it('returns empty when cap is 0', () => {
    const r = selectSourcesUnderCap({ a: F('a1', 'a2') }, [], new Set(), 0);
    assert.equal(r.keep.size, 0);
    assert.deepEqual([...r.autoDisabled].sort(), ['a1', 'a2']);
  });

  it('returns empty for negative cap (defensive)', () => {
    const r = selectSourcesUnderCap({ a: F('a1') }, [], new Set(), -5);
    assert.equal(r.keep.size, 0);
    assert.equal(r.autoDisabled.size, 0);
  });

  it('keeps everything when total <= cap', () => {
    const r = selectSourcesUnderCap(
      { a: F('a1', 'a2'), b: F('b1') },
      F('intel-1'),
      new Set(),
      10,
    );
    assert.equal(r.keep.size, 4);
    assert.equal(r.autoDisabled.size, 0);
    assert.ok(r.keep.has('a1') && r.keep.has('a2') && r.keep.has('b1') && r.keep.has('intel-1'));
  });

  it('REGRESSION: every category gets at least 1 source when cap is small but >= category count', () => {
    // The pre-fix bug: alphabetical sort + slice(0, N) could leave entire
    // categories with ZERO enabled sources. Round-robin must keep ≥1 from
    // each category until budget exhausted.
    const feeds = {
      'aaa-cat': F('alpha-1', 'alpha-2', 'alpha-3'),
      'bbb-cat': F('beta-1', 'beta-2'),
      'zzz-cat': F('zeta-1', 'zeta-2'), // alphabetically last — was the bug victim
    };
    const r = selectSourcesUnderCap(feeds, [], new Set(), 3);
    assert.equal(r.keep.size, 3);
    // All three categories must have at least one source kept
    assert.ok(r.keep.has('alpha-1'), 'aaa-cat must keep alpha-1');
    assert.ok(r.keep.has('beta-1'), 'bbb-cat must keep beta-1');
    assert.ok(r.keep.has('zeta-1'), 'zzz-cat must keep zeta-1 (was the bug victim)');
  });

  it('REGRESSION: late-alphabet categories are not starved at production-realistic scale', () => {
    // Approximate the production shape: 30 categories, 3-4 feeds each, cap=80.
    // Pre-fix: late-alphabet categories went empty. Post-fix: every category
    // keeps at least its first feed.
    const categories: { [k: string]: ReturnType<typeof F> } = {};
    const letters = 'abcdefghijklmnopqrstuvwxyz1234'.split('');
    for (const letter of letters) {
      categories[`cat-${letter}`] = F(`${letter}-1`, `${letter}-2`, `${letter}-3`);
    }
    const r = selectSourcesUnderCap(categories, [], new Set(), 80);

    for (const letter of letters) {
      assert.ok(
        r.keep.has(`${letter}-1`),
        `category cat-${letter} must keep its first source ${letter}-1 (would have been auto-disabled by pre-fix alphabetical slice for late letters)`,
      );
    }
  });

  it('respects user-disabled sources — never adds them to keep', () => {
    const feeds = { a: F('a1', 'a2'), b: F('b1', 'b2') };
    const userDisabled = new Set(['a1', 'b2']);
    const r = selectSourcesUnderCap(feeds, [], userDisabled, 10);
    assert.ok(!r.keep.has('a1'), 'a1 was user-disabled — must not be re-enabled');
    assert.ok(!r.keep.has('b2'), 'b2 was user-disabled — must not be re-enabled');
    assert.ok(r.keep.has('a2') && r.keep.has('b1'));
    // autoDisabled is the cap-rejected set — it should NOT include user-disabled
    assert.ok(!r.autoDisabled.has('a1'));
    assert.ok(!r.autoDisabled.has('b2'));
  });

  it('takes within-category sources in declaration order (editorial primary first)', () => {
    // feeds.ts editorial team controls "primary source" by listing it first.
    // Round-robin shifts from the front of each bucket — primary always wins.
    const feeds = { a: F('primary', 'secondary', 'tertiary') };
    const r = selectSourcesUnderCap(feeds, [], new Set(), 1);
    assert.ok(r.keep.has('primary'));
    assert.ok(!r.keep.has('secondary'));
    assert.ok(!r.keep.has('tertiary'));
  });

  it('handles INTEL_SOURCES as its own bucket (does not dominate categories)', () => {
    const feeds = { a: F('a1'), b: F('b1') };
    const intel = F('intel-1', 'intel-2', 'intel-3');
    const r = selectSourcesUnderCap(feeds, intel, new Set(), 3);
    // Round-robin: a1, b1, intel-1
    assert.ok(r.keep.has('a1'));
    assert.ok(r.keep.has('b1'));
    assert.ok(r.keep.has('intel-1'));
    assert.equal(r.keep.size, 3);
  });

  it('REGRESSION (#5950): UA/RU balance sources survive free-tier europe late-bucket ordering', () => {
    // europe declaration puts pan-EU defaults first; Kyiv Independent / Meduza /
    // Moscow Times sit late. With many categories and FREE_MAX_SOURCES=80,
    // round-robin only keeps ~5 europe slots — without protectedNames the
    // balance set is auto-disabled while tests on DEFAULT_ENABLED stay green.
    const europe = F(
      'France 24', 'EuroNews', 'Le Monde', 'DW News', 'Tagesschau', 'ANSA',
      'NOS Nieuws', 'SVT Nyheter', 'Balkan Insight',
      'TVN24', 'Rzeczpospolita',
      'Meduza', 'Kyiv Independent', 'Moscow Times',
    );
    // ~16 buckets × 5 slots ≈ 80 — europe late names drop without protection.
    const categories: { [k: string]: ReturnType<typeof F> } = { europe };
    for (let i = 0; i < 15; i++) {
      categories[`cat-${i}`] = F(`c${i}-1`, `c${i}-2`, `c${i}-3`, `c${i}-4`, `c${i}-5`);
    }
    const CAP = 80;
    const balance = new Set(['Kyiv Independent', 'Meduza', 'Moscow Times']);

    const baseline = selectSourcesUnderCap(categories, [], new Set(), CAP);
    for (const name of balance) {
      assert.ok(
        !baseline.keep.has(name),
        `baseline should NOT keep ${name} (proves free-tier drop without protection)`,
      );
    }

    const protectedRun = selectSourcesUnderCap(categories, [], new Set(), CAP, balance);
    for (const name of balance) {
      assert.ok(protectedRun.keep.has(name), `protected free-tier run MUST keep ${name}`);
      assert.ok(!protectedRun.autoDisabled.has(name), `${name} must not be auto-disabled`);
    }
  });

  it('REGRESSION (PR #3857): locale-late entries in a bucket survive the cap when protected', () => {
    // Reproduces the Hungarian-feeds-disabled-by-cap bug: hu-tagged entries
    // declared AFTER the existing Europe defaults get round-robin'd out
    // for free-tier hu users without `protectedNames`. Numbers chosen so
    // cap stops before reaching hu entries in the baseline, and so cap
    // can fit all hu entries plus some defaults in the protected run.
    const europe = F(
      // English/German/Italian/Dutch/Swedish defaults (positions 1-12)
      'EuroNews', 'DW News', 'Tagesschau', 'ANSA', 'NOS Nieuws', 'SVT Nyheter',
      'France 24', 'Le Monde', 'Corriere', 'Repubblica', 'NRC', 'Dagens Nyheter',
      // Hungarian (positions 13-18 in declaration order)
      'Telex', 'Index.hu', 'HVG', '444.hu', '24.hu', 'ATV',
    );
    const feeds = { europe };
    const huBoost = new Set(['Telex', 'Index.hu', 'HVG', '444.hu', '24.hu', 'ATV']);
    const CAP = 10;

    // Without protection: round-robin with a single bucket eats positions
    // 1-CAP in declaration order → all 10 slots go to en/de/it defaults,
    // zero Hungarian sources reached.
    const baseline = selectSourcesUnderCap(feeds, [], new Set(), CAP);
    for (const hu of huBoost) {
      assert.ok(!baseline.keep.has(hu), `baseline should NOT keep ${hu} (proves the bug exists)`);
    }
    assert.equal(baseline.keep.size, CAP);

    // With protection: all 6 Hungarian sources kept, remaining 4 cap slots
    // go to round-robin defaults (EuroNews, DW News, Tagesschau, ANSA).
    const protectedRun = selectSourcesUnderCap(feeds, [], new Set(), CAP, huBoost);
    for (const hu of huBoost) {
      assert.ok(protectedRun.keep.has(hu), `protected run MUST keep ${hu}`);
    }
    assert.equal(protectedRun.keep.size, CAP, 'protected names count toward cap (no unbounded expansion)');

    // Cap < protected.size: protected fills first, takes a prefix. No
    // unbounded expansion; some protected names get dropped (matches the
    // overall "cap is a hard ceiling" contract).
    const tinyCapRun = selectSourcesUnderCap(feeds, [], new Set(), 3, huBoost);
    assert.equal(tinyCapRun.keep.size, 3, 'cap is a hard ceiling even with protected names');
  });

  it('protected name in userDisabled stays excluded (user intent wins)', () => {
    const feeds = { a: F('a1', 'a2'), b: F('b1', 'b2') };
    const userDisabled = new Set(['a1']);
    const protectedNames = new Set(['a1', 'b1']);
    const r = selectSourcesUnderCap(feeds, [], userDisabled, 4, protectedNames);
    assert.ok(!r.keep.has('a1'), 'user-disabled MUST stay disabled even when protected');
    assert.ok(r.keep.has('b1'), 'non-conflicting protected stays kept');
  });

  it('protected names not in any bucket are silently ignored', () => {
    const feeds = { a: F('a1', 'a2') };
    const protectedNames = new Set(['nonexistent-source-name']);
    const r = selectSourcesUnderCap(feeds, [], new Set(), 2, protectedNames);
    assert.equal(r.keep.size, 2);
    assert.ok(!r.keep.has('nonexistent-source-name'));
  });

  it('is deterministic across repeated calls with same input', () => {
    const feeds = {
      a: F('a1', 'a2', 'a3'),
      b: F('b1', 'b2'),
      c: F('c1', 'c2', 'c3', 'c4'),
    };
    const r1 = selectSourcesUnderCap(feeds, [], new Set(), 5);
    const r2 = selectSourcesUnderCap(feeds, [], new Set(), 5);
    assert.deepEqual([...r1.keep].sort(), [...r2.keep].sort());
    assert.deepEqual([...r1.autoDisabled].sort(), [...r2.autoDisabled].sort());
  });

  it('skips empty / undefined categories without crashing', () => {
    const feeds = { a: F('a1'), b: undefined, c: [] };
    const r = selectSourcesUnderCap(feeds, [], new Set(), 10);
    assert.equal(r.keep.size, 1);
    assert.ok(r.keep.has('a1'));
  });

  it('uses Object.entries iteration order (deterministic per category insertion)', () => {
    // With only 1 slot and 3 categories, only the first category's first source
    // makes it. This documents that category iteration follows insertion order.
    const feeds = { gamma: F('g1'), alpha: F('a1'), beta: F('b1') };
    const r = selectSourcesUnderCap(feeds, [], new Set(), 1);
    assert.ok(r.keep.has('g1'), 'gamma was first-inserted — gets the slot');
    assert.ok(!r.keep.has('a1'));
    assert.ok(!r.keep.has('b1'));
  });

  it('autoDisabled excludes sources the user explicitly disabled', () => {
    const feeds = { a: F('a1', 'a2', 'a3') };
    const userDisabled = new Set(['a3']);
    const r = selectSourcesUnderCap(feeds, [], userDisabled, 1);
    assert.ok(r.keep.has('a1'));
    // a2 didn't make the cap → autoDisabled. a3 is user-disabled → not in either.
    assert.ok(r.autoDisabled.has('a2'));
    assert.ok(!r.autoDisabled.has('a3'));
    assert.ok(!r.keep.has('a3'));
  });
});

describe('selectSourcesUnderCap: duplicate source names across buckets (feeds.ts reality)', () => {
  // feeds.ts contains 35+ names appearing in multiple categories
  // (Yahoo Finance × 4, CNBC × 3, MarketWatch × 3, Layoffs.fyi × 2, ...).
  // These tests pin down the must-not-regress invariant: kept names
  // never end up in autoDisabled, regardless of how many buckets contain
  // them.

  it('REGRESSION: a duplicate name kept via one bucket is not auto-disabled by another', () => {
    // Yahoo Finance lives in BOTH 'markets' and 'finance' buckets.
    // Cap is generous → we expect Yahoo Finance in keep, NOT in autoDisabled.
    const feeds = {
      markets: F('Yahoo Finance', 'CNBC'),
      finance: F('Yahoo Finance', 'Bloomberg'),
    };
    const r = selectSourcesUnderCap(feeds, [], new Set(), 10);
    assert.ok(r.keep.has('Yahoo Finance'));
    assert.ok(
      !r.autoDisabled.has('Yahoo Finance'),
      'kept name must NEVER appear in autoDisabled — caller would re-disable it',
    );
    // Sanity: keep ∩ autoDisabled must be empty for ALL names
    for (const k of r.keep) {
      assert.ok(!r.autoDisabled.has(k), `${k} appeared in both keep and autoDisabled`);
    }
  });

  it('REGRESSION: duplicate names do not waste round-robin slots when cap is tight', () => {
    // 3 buckets, each contains 2 names where the FIRST is a shared duplicate.
    // Pre-fix: round-robin pulled the duplicate from each bucket, "consuming"
    // 3 slots but only adding 1 unique to keep — leaving cap=3 with only 1
    // unique kept name and 2 unique-secondary names auto-disabled.
    // Post-fix: the helper drops already-keep'd names before consuming a
    // turn, so each bucket cleanly contributes its unique secondary.
    const feeds = {
      a: F('SHARED', 'a-only'),
      b: F('SHARED', 'b-only'),
      c: F('SHARED', 'c-only'),
    };
    const r = selectSourcesUnderCap(feeds, [], new Set(), 4);
    assert.equal(r.keep.size, 4, 'all 4 unique names must fit under cap=4');
    assert.ok(r.keep.has('SHARED'));
    assert.ok(r.keep.has('a-only'));
    assert.ok(r.keep.has('b-only'));
    assert.ok(r.keep.has('c-only'));
    assert.equal(r.autoDisabled.size, 0);
  });

  it('REGRESSION: duplicate at cap boundary — kept name not auto-disabled when cap=1', () => {
    // Cap is 1. Bucket a yields 'SHARED' first. Bucket b also has 'SHARED'
    // followed by 'b-unique'. After 'SHARED' is keep'd via bucket a, bucket
    // b's leading 'SHARED' must be dropped (not consume a slot at cap=1)
    // and 'SHARED' must NOT show up in autoDisabled.
    const feeds = {
      a: F('SHARED'),
      b: F('SHARED', 'b-unique'),
    };
    const r = selectSourcesUnderCap(feeds, [], new Set(), 1);
    assert.equal(r.keep.size, 1);
    assert.ok(r.keep.has('SHARED'));
    assert.ok(!r.autoDisabled.has('SHARED'), 'kept name must not be in autoDisabled');
    // b-unique didn't fit and is correctly auto-disabled
    assert.ok(r.autoDisabled.has('b-unique'));
  });

  it('REGRESSION: many consecutive duplicates at bucket front are all skipped', () => {
    // Bucket b has duplicate of 'a1' AND 'a2' from bucket a at its front.
    // The drop-while loop must drain BOTH before considering b-unique.
    const feeds = {
      a: F('a1', 'a2'),
      b: F('a1', 'a2', 'b-unique'),
    };
    const r = selectSourcesUnderCap(feeds, [], new Set(), 3);
    assert.equal(r.keep.size, 3);
    assert.ok(r.keep.has('a1'));
    assert.ok(r.keep.has('a2'));
    assert.ok(r.keep.has('b-unique'));
    assert.equal(r.autoDisabled.size, 0);
  });

  it('keep ∩ autoDisabled invariant holds at production-scale duplicate density', () => {
    // Mirror the real feeds.ts pattern: 5 categories, with Yahoo Finance,
    // CNBC, MarketWatch each appearing in multiple categories. Cap=8 is
    // tight — forces round-robin under load.
    const feeds = {
      markets: F('Yahoo Finance', 'CNBC', 'AAPL News'),
      finance: F('Yahoo Finance', 'CNBC', 'MarketWatch', 'WSJ'),
      crypto: F('CoinDesk', 'CoinTelegraph'),
      etfflows: F('Yahoo Finance', 'BlackRock'),
      energy: F('OilPrice.com', 'Reuters Energy'),
    };
    const r = selectSourcesUnderCap(feeds, [], new Set(), 8);
    for (const k of r.keep) {
      assert.ok(
        !r.autoDisabled.has(k),
        `name ${k} appears in BOTH keep and autoDisabled`,
      );
    }
  });
});

describe('findFullyDisabledCategories: recover v1 cap-bug victims', () => {
  it('returns empty when no category is 100% disabled', () => {
    const feeds = { a: F('a1', 'a2'), b: F('b1', 'b2') };
    const disabled = new Set(['a1']); // partial — keep a2 and all of b
    assert.deepEqual(findFullyDisabledCategories(feeds, disabled), []);
  });

  it('returns sources from a 100%-disabled category', () => {
    const feeds = { a: F('a1', 'a2', 'a3'), b: F('b1') };
    const disabled = new Set(['a1', 'a2', 'a3']); // category a is fully disabled
    const r = findFullyDisabledCategories(feeds, disabled);
    assert.deepEqual(r.sort(), ['a1', 'a2', 'a3']);
  });

  it('returns sources from MULTIPLE fully-disabled categories', () => {
    const feeds = {
      layoffs: F('Layoffs.fyi', 'TechCrunch Layoffs', 'Layoffs News'),
      ipo: F('IPO News', 'Renaissance IPO', 'Tech IPO News'),
      politics: F('Reuters', 'AP'), // healthy
    };
    const disabled = new Set([
      'Layoffs.fyi', 'TechCrunch Layoffs', 'Layoffs News',
      'IPO News', 'Renaissance IPO', 'Tech IPO News',
    ]);
    const r = findFullyDisabledCategories(feeds, disabled);
    assert.equal(r.length, 6);
    assert.ok(r.includes('Layoffs.fyi'));
    assert.ok(r.includes('IPO News'));
    assert.ok(!r.includes('Reuters'), 'healthy categories must not be touched');
  });

  it('preserves explicit single-source disabling (the heuristic\'s key safety property)', () => {
    // User explicitly toggled OFF one source in a multi-source category.
    // That's a real preference we must not undo.
    const feeds = { politics: F('Reuters', 'AP', 'CNN') };
    const disabled = new Set(['CNN']); // user toggled CNN off
    const r = findFullyDisabledCategories(feeds, disabled);
    assert.deepEqual(r, [], 'partial disable must NOT be flagged as bug victim');
  });

  it('handles empty / undefined / single-source categories without false positives', () => {
    const feeds = {
      empty: [],
      undef: undefined,
      single: F('only-one'),
    };
    // single category with its only source disabled IS a 100% disabled category
    const disabled = new Set(['only-one']);
    const r = findFullyDisabledCategories(feeds, disabled);
    assert.deepEqual(r, ['only-one']);
  });

  it('returns empty when disabled set is empty', () => {
    const feeds = { a: F('a1', 'a2'), b: F('b1') };
    assert.deepEqual(findFullyDisabledCategories(feeds, new Set()), []);
  });
});
