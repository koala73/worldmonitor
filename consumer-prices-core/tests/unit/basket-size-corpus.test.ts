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
 *
 * A second class of config bug — a declared pack that its own quantity window
 * cannot admit — is covered below. Surfaced by #6869: `Drinking Water 24 Pack
 * 16oz` is ~11.4L but lived under a 6–10L window; the full-name replay above
 * could not see it because `PACK_PATTERN` is start-anchored and the prefixed
 * name fails to parse.
 */
import { describe, expect, it } from 'vitest';
import { loadAllBasketConfigs } from '../../src/config/loader.js';
import { validateSearchHit, type SizeWindowStatus } from '../../src/adapters/validator.js';
import { parseSize, type ParsedSize } from '../../src/normalizers/size.js';

interface Replayed {
  label: string;
  status: SizeWindowStatus;
  ok: boolean;
  reasons: string[];
}

/** Same factor as UNIT_MAP `fl` — US retail "oz" on liquids is fluid ounces. */
const FL_OZ_TO_ML = 29.5735;

/**
 * Walk left-to-right over word boundaries until `parseSize` succeeds. Needed
 * because many canonical names put a product descriptor before the pack
 * (`Drinking Water 24 Pack 16oz`, `Still Water 6 x 1.5L`) and PACK_PATTERN is
 * anchored at `^`.
 */
function extractDeclaredSize(canonicalName: string): string | null {
  if (parseSize(canonicalName)) return canonicalName;
  const words = canonicalName.trim().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const candidate = words.slice(i).join(' ');
    if (parseSize(candidate)) return candidate;
  }
  return null;
}

/**
 * Convert a parsed declared size into the item's `baseUnit` for a config
 * self-check. When the item is liquid (`ml`) and the size is `oz`, treat it as
 * fluid ounces — UNIT_MAP maps `oz` to grams for the runtime density band, but
 * the basket author who wrote "24 Pack 16oz" meant volume.
 */
function declaredQtyInItemUnits(parsed: ParsedSize, baseUnit: string): number | null {
  if (parsed.baseUnit === baseUnit) return parsed.baseQuantity;
  if (baseUnit === 'ml' && /^(?:oz|ounce)s?$/i.test(parsed.sizeUnit)) {
    return parsed.packCount * parsed.sizeValue * FL_OZ_TO_ML;
  }
  return null;
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
    // `absent`/`unverified` (non-decisive verdicts) and "nothing is rejected"
    // would prove nothing. 101 of 119 items resolve to `pass` today; the floor
    // sits below that so ordinary basket edits do not trip it, but a parsing
    // regression that silently neutralises the window does.
    expect(passed.length).toBeGreaterThanOrEqual(90);
  });

  it('never reports a decisive unit mismatch against a configured item', () => {
    const mismatched = replayCorpus().filter((r) => r.status === 'unit-mismatch');
    expect(
      mismatched.map((r) => r.label),
      'an item whose own size mismatches its declared baseUnit is a config bug',
    ).toEqual([]);
  });

  // CONFIG SELF-CHECK (#6869). The replay above feeds the full canonical name
  // as sizeText, so a prefixed pack that PACK_PATTERN cannot see lands on
  // `unknown` and quietly passes. This guard strips the product descriptor,
  // converts the declared pack into the item's base unit, and asserts the
  // quantity window admits it — the two halves of the item must agree.
  it('admits every parseable declared pack inside its own quantity window', () => {
    const outside: string[] = [];
    const uncheckable: string[] = [];
    const checked: string[] = [];
    for (const basket of loadAllBasketConfigs()) {
      for (const item of basket.items) {
        const label = `${basket.slug}/${item.id}`;
        const sizeText = extractDeclaredSize(item.canonicalName);
        if (!sizeText) continue;
        const parsed = parseSize(sizeText);
        if (!parsed) {
          uncheckable.push(`${label} extracted but could not reparse "${sizeText}"`);
          continue;
        }
        if (item.minBaseQty == null && item.maxBaseQty == null) {
          uncheckable.push(`${label} parses as "${sizeText}" but has no quantity window`);
          continue;
        }
        const qty = declaredQtyInItemUnits(parsed, item.baseUnit);
        if (qty == null) {
          uncheckable.push(
            `${label} cannot convert ${parsed.sizeUnit}/${parsed.baseUnit} to ${item.baseUnit}`,
          );
          continue;
        }
        checked.push(label);
        const min = item.minBaseQty ?? 0;
        const max = item.maxBaseQty ?? Number.POSITIVE_INFINITY;
        if (qty < min || qty > max) {
          outside.push(
            `${basket.slug}/${item.id} "${item.canonicalName}" ` +
              `size=${sizeText} qty=${qty.toFixed(1)}${item.baseUnit} ` +
              `window=[${min},${max}]`,
          );
        }
      }
    }
    expect(
      uncheckable,
      'every extracted canonical quantity must be checked against a compatible window',
    ).toEqual([]);
    // Population sanity plus a target assertion: a large unrelated cohort can
    // no longer hide the US water item disappearing from the checked set.
    expect(checked.length).toBeGreaterThanOrEqual(90);
    expect(checked).toContain('essentials-us/water_1_5l');
    expect(
      outside,
      'a basket item must admit the pack its own canonicalName describes',
    ).toEqual([]);
  });

  it('converts every parser-supported ounce spelling for liquid config checks', () => {
    for (const unit of ['oz', 'ozs', 'ounce', 'ounces']) {
      const parsed = parseSize(`24 Pack 16 ${unit}`);
      expect(parsed, `${unit} must remain parseable`).not.toBeNull();
      if (!parsed) continue;
      expect(declaredQtyInItemUnits(parsed, 'ml')).toBeCloseTo(24 * 16 * FL_OZ_TO_ML);
    }
  });

  describe('US drinking-water quantity boundaries (#6869)', () => {
    const water = loadAllBasketConfigs()
      .find((basket) => basket.slug === 'essentials-us')
      ?.items.find((item) => item.id === 'water_1_5l');

    if (!water) throw new Error('essentials-us/water_1_5l is missing');

    it('admits the 24 x 16.9 fl oz upper-bound pack', () => {
      const result = validateSearchHit({
        canonicalName: water.canonicalName,
        productName: 'Purified Drinking Water 24 Pack',
        sizeText: '24 x 16.9 fl oz',
        item: water,
      });

      expect(result.ok).toBe(true);
      expect(result.signals.sizeWindow).toBe('pass');
    });

    it('rejects a 32 x 16 oz pack across the density band', () => {
      const result = validateSearchHit({
        canonicalName: water.canonicalName,
        productName: 'Purified Drinking Water 32 Pack',
        sizeText: '32 x 16 oz',
        item: water,
      });

      expect(result.ok).toBe(false);
      expect(result.signals.sizeWindow).toBe('unit-mismatch');
    });
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
