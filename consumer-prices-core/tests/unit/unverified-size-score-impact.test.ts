/**
 * Offline impact characterisation for #6868.
 *
 * The live corpus replay in the issue (3,604 stored observations / 90 days /
 * 8 markets / 21 retailers) found 339 rows (9.4%) whose sizeText parseSize
 * cannot read. Under the pre-#6868 scorer those shared the 0.2 "neutral"
 * weight with structurally-absent sizes, so a full-overlap hit published at
 * 0.85. After the absent/unverified split every such hit lands at 0.70 —
 * below AUTO_MATCH_THRESHOLD — so the entire unparseable-auto population
 * demotes to `candidate`.
 *
 * This file freezes that demotion against the configured basket corpus and
 * the unparseable unit tokens the issue ranked, without needing the
 * observation store. A live DATABASE_URL replay remains the authoritative
 * count for production rows; the math here proves the demotion is universal
 * for any full-overlap unverified hit (max old score 0.85, delta −0.15).
 */
import { describe, expect, it } from 'vitest';
import { loadAllBasketConfigs } from '../../src/config/loader.js';
import { AUTO_MATCH_THRESHOLD, validateSearchHit } from '../../src/adapters/validator.js';
import { parseSize } from '../../src/normalizers/size.js';

/** Leading unit tokens the #6868 corpus ranked as unmatched (parse → null). */
const UNPARSEABLE_SIZE_TEXTS = [
  '24 pack',
  '12 unidades',
  '6 count',
  '12 eggs',
  '2 pint',
  '6 pk',
  '1 litros',
  '1 litro',
] as const;

describe('#6868 unverified-size score impact', () => {
  it('confirms the ranked tokens still do not parse', () => {
    for (const raw of UNPARSEABLE_SIZE_TEXTS) {
      expect(parseSize(raw), raw).toBeNull();
    }
  });

  it('demotes every full-overlap unparseable hit below auto for every windowed item', () => {
    const stillAuto: string[] = [];
    let checked = 0;
    for (const basket of loadAllBasketConfigs()) {
      for (const item of basket.items) {
        if (item.minBaseQty == null && item.maxBaseQty == null) continue;
        checked++;
        for (const sizeText of UNPARSEABLE_SIZE_TEXTS) {
          const r = validateSearchHit({
            canonicalName: item.canonicalName,
            productName: item.canonicalName,
            sizeText,
            item,
          });
          if (r.signals.sizeWindow !== 'unverified' || r.score >= AUTO_MATCH_THRESHOLD) {
            stillAuto.push(
              `${basket.slug}/${item.id} size=${sizeText} status=${r.signals.sizeWindow} score=${r.score}`,
            );
          }
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(100);
    expect(stillAuto, 'an unparseable size must never clear AUTO_MATCH_THRESHOLD').toEqual([]);
  });

  it('leaves structurally-absent sizes publishing for every windowed item', () => {
    const demoted: string[] = [];
    for (const basket of loadAllBasketConfigs()) {
      for (const item of basket.items) {
        if (item.minBaseQty == null && item.maxBaseQty == null) continue;
        const r = validateSearchHit({
          canonicalName: item.canonicalName,
          productName: item.canonicalName,
          sizeText: undefined,
          item,
        });
        if (r.signals.sizeWindow !== 'absent' || r.score < AUTO_MATCH_THRESHOLD) {
          demoted.push(
            `${basket.slug}/${item.id} status=${r.signals.sizeWindow} score=${r.score}`,
          );
        }
      }
    }
    expect(demoted, 'missing sizeText must keep the historical 0.2 weight').toEqual([]);
  });

  // Density-reconcilable carve-outs also move to unverified. Count how many
  // configured content-measure items would demote when labelled in the other
  // dimension at mid-window — the same population the #6267 positive control
  // keeps from hard-rejecting. This is the offline proxy for "how many
  // currently-auto carve-out rows move to candidate".
  it('quantifies density-carve-out demotions across the basket corpus', () => {
    let carveOutAutos = 0;
    for (const basket of loadAllBasketConfigs()) {
      for (const item of basket.items) {
        if (item.baseUnit !== 'g' && item.baseUnit !== 'ml') continue;
        const min = item.minBaseQty;
        const max = item.maxBaseQty;
        if (min == null || max == null) continue;
        const mid = (min + max) / 2;
        const other = item.baseUnit === 'ml' ? 'g' : 'ml';
        const r = validateSearchHit({
          canonicalName: item.canonicalName,
          productName: item.canonicalName,
          sizeText: `${Math.round(mid)} ${other}`,
          item,
        });
        expect(r.ok).toBe(true);
        expect(r.signals.sizeWindow).toBe('unverified');
        if (r.score < AUTO_MATCH_THRESHOLD) carveOutAutos++;
      }
    }
    // Every content-measure item with a window is a demotion under the new
    // weight. Pin a floor so a scoring regression that restores 0.2 cannot
    // hide behind a quiet green.
    expect(carveOutAutos).toBeGreaterThanOrEqual(100);
  });
});
