/**
 * Corpus replay for the #6267 size rules.
 *
 * Both rules that issue tightened the validator — spelled-out units now parse,
 * and a mismatch between two CONTENT measures is a hard reject — can only be
 * judged against the population they govern, not against hand-picked fixtures.
 * The cheapest honest proxy for "recent observations" is the basket corpus
 * itself: a retailer hit for an item normally carries that item's own size, so
 * replaying every configured item against its own canonical size measures
 * whether the tightened rules reject anything they should have accepted.
 *
 * This caught a real landmine while #6267 was being written. The US basket
 * declares `Vegetable Oil 48oz` in `ml` (window 1200-1600), but `oz` maps to
 * grams — so the obvious "different measure is a fail" rule would have
 * hard-rejected the correct US product. That is why the cross-dimension check
 * decides on magnitude across a density band rather than on the unit token.
 *
 * Note what this file does and does not cover. Every canonical name in the
 * corpus uses a unit that was already mapped before #6267 (`kg`, `g`, `l`,
 * `ml`, `oz`, `lb`, `Gallon`), so it exercises the cross-dimension rule but
 * NOT the spelled-out-unit parsing — tests/unit/size.test.ts owns that.
 */
import { describe, expect, it } from 'vitest';
import { loadAllBasketConfigs } from '../../src/config/loader.js';
import { validateSearchHit, type SizeWindowStatus } from '../../src/adapters/validator.js';

interface Replayed {
  label: string;
  status: SizeWindowStatus;
  ok: boolean;
  reasons: string[];
}

function replayCorpus(): Replayed[] {
  const out: Replayed[] = [];
  for (const basket of loadAllBasketConfigs()) {
    for (const item of basket.items) {
      // productName and sizeText both come from the canonical name, so token
      // overlap is 1.0 by construction and the ONLY thing under test is the
      // size verdict. A hit that fails here fails on its size alone.
      const r = validateSearchHit({
        canonicalName: item.canonicalName,
        productName: item.canonicalName,
        sizeText: item.canonicalName,
        item,
      });
      out.push({
        label: `${basket.slug}/${item.id} "${item.canonicalName}" (baseUnit=${item.baseUnit})`,
        status: r.signals.sizeWindow,
        ok: r.ok,
        reasons: r.reasons,
      });
    }
  }
  return out;
}

describe('basket corpus vs the #6267 size rules', () => {
  it('rejects no configured item carrying its own canonical size', () => {
    const replayed = replayCorpus();
    // Population sanity: an empty or truncated corpus would make every other
    // assertion here vacuously true.
    expect(replayed.length).toBeGreaterThanOrEqual(100);

    const rejected = replayed.filter((r) => !r.ok);
    expect(
      rejected.map((r) => `${r.label} -> ${r.reasons.join(',')}`),
      'a basket item must never be rejected for carrying its own declared size',
    ).toEqual([]);
  });

  it('runs the quantity window on the bulk of the corpus', () => {
    const replayed = replayCorpus();
    const passed = replayed.filter((r) => r.status === 'pass');
    // Teeth for the assertion above: without this, every item could drift into
    // `unknown` (the neutral verdict) and "nothing is rejected" would prove
    // nothing. 101 of 119 items resolve to `pass` today; the floor sits below
    // that so ordinary basket edits do not trip it, but a parsing regression
    // that silently neutralises the window does.
    expect(passed.length).toBeGreaterThanOrEqual(90);
  });

  it('never reports a decisive unit mismatch against a configured item', () => {
    const mismatched = replayCorpus().filter((r) => r.status === 'unit-mismatch');
    expect(
      mismatched.map((r) => r.label),
      'an item whose own size mismatches its declared baseUnit is a config bug',
    ).toEqual([]);
  });

  // POSITIVE CONTROL. Everything above asserts that nothing happens, and a rule
  // that never fires on this population is indistinguishable from a rule that
  // was deleted — the whole cross-dimension check could be removed and the
  // assertions above would stay green. These two cases make the corpus prove
  // the rule still FIRES, in both of the directions it has to get right.
  describe('the cross-dimension rule still fires on this corpus', () => {
    // Every content-measure item, fed a size in the OTHER dimension whose
    // magnitude no plausible density can reconcile, must reject.
    it('rejects an implausible cross-dimension size for every measure item', () => {
      const survived: string[] = [];
      let checked = 0;
      for (const basket of loadAllBasketConfigs()) {
        for (const it of basket.items) {
          if (it.baseUnit !== 'g' && it.baseUnit !== 'ml') continue;
          const max = it.maxBaseQty ?? 0;
          if (max <= 0) continue;
          checked++;
          // 50x the window ceiling, expressed in the opposite dimension.
          const other = it.baseUnit === 'ml' ? 'g' : 'ml';
          const r = validateSearchHit({
            canonicalName: it.canonicalName,
            productName: it.canonicalName,
            sizeText: `${Math.ceil(max * 50)} ${other}`,
            item: it,
          });
          if (r.signals.sizeWindow !== 'unit-mismatch') {
            survived.push(`${basket.slug}/${it.id} -> ${r.signals.sizeWindow}`);
          }
        }
      }
      expect(checked).toBeGreaterThanOrEqual(100);
      expect(survived, 'the cross-dimension rule did not fire').toEqual([]);
    });

    // ...but a size in the other dimension that IS reconcilable at a plausible
    // density is the same product labelled differently (a 1L oil bottle whose
    // label reads 910g) and must NOT reject. Without this, a rule that simply
    // rejects every cross-dimension size would pass the test above.
    it('accepts a density-reconcilable cross-dimension size for every measure item', () => {
      const rejected: string[] = [];
      for (const basket of loadAllBasketConfigs()) {
        for (const it of basket.items) {
          if (it.baseUnit !== 'g' && it.baseUnit !== 'ml') continue;
          const min = it.minBaseQty;
          const max = it.maxBaseQty;
          if (min == null || max == null) continue;
          const mid = (min + max) / 2;
          const other = it.baseUnit === 'ml' ? 'g' : 'ml';
          const r = validateSearchHit({
            canonicalName: it.canonicalName,
            productName: it.canonicalName,
            sizeText: `${Math.round(mid)} ${other}`,
            item: it,
          });
          if (r.signals.sizeWindow === 'unit-mismatch') {
            rejected.push(`${basket.slug}/${it.id} "${it.canonicalName}" mid=${mid}${other}`);
          }
        }
      }
      expect(
        rejected,
        'a same-magnitude size in the other dimension is the same product relabelled',
      ).toEqual([]);
    });
  });
});

describe('US drinking water: the window admits the pack it declares (#6869)', () => {
  // 24 x 16 fl oz = 11,356 ml sat ABOVE the old 10,000 ceiling, so the item
  // could only ever price through sizes that failed to parse — a price that
  // survived because the window never ran. The raised window admits both the
  // declared 16oz pack and the very common 16.9oz bottle, while the 32-packs
  // Walmart actually serves (~1.6x the intended pack) stay rejected.
  const us = loadAllBasketConfigs().find((b) => b.slug === 'essentials-us');
  const water = us?.items.find((it) => it.id === 'water_1_5l');

  it('finds the item (guard against silent config moves)', () => {
    expect(water).toBeTruthy();
  });

  // Same-unit sizes, so the verdict exercises the hard window rather than the
  // cross-dimension density band: the declared pack expressed in the item's
  // own ml, and the 32-pack retailers actually serve.
  const cases: Array<[string, SizeWindowStatus]> = [
    ['24 x 473 ml', 'pass'],
    ['11.4 L', 'pass'],
    ['32 x 500 ml', 'fail'],
  ];

  for (const [sizeText, expected] of cases) {
    it(`"${sizeText}" -> ${expected}`, () => {
      const r = validateSearchHit({
        canonicalName: water!.canonicalName,
        productName: 'Aquafina Purified Drinking Water',
        sizeText,
        item: water!,
      });
      expect(r.signals.sizeWindow).toBe(expected);
    });
  }
});
