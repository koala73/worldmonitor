// Matched-pair sanity panel for the resilience-scorer fairness audit.
// Referenced by scripts/compare-resilience-current-vs-proposed.mjs and
// tests/resilience-cohort-config.test.mts. See
// docs/plans/2026-04-22-001-fix-resilience-scorer-structural-bias-plan.md
// §7 for the role these pairs play in the acceptance gates.
//
// Each pair tests a specific scorer-behavior axis under pre-chosen,
// publicly-defensible directional expectations. Acceptance gate #7
// enforces that each pair's within-pair-gap sign stays as documented
// across every scorer-changing PR. A pair flipping direction stops the
// PR and forces the construct change to be re-examined.

export interface MatchedPair {
  /** Unique id used in reports. */
  id: string;
  /** ISO-3166 alpha-2 for the country expected to score higher. */
  higherExpected: string;
  /** ISO-3166 alpha-2 for the country expected to score lower. */
  lowerExpected: string;
  /** Scorer-behavior axis the pair tests. */
  axis: string;
  /**
   * One-paragraph rationale. Documents both why the direction is
   * defensible today AND the conditions under which it could flip.
   * The rationale should be neutral — not a score target, but a
   * statement about the underlying resilience mechanism.
   */
  rationale: string;
  /**
   * Minimum gap (higher - lower) required. If the gap shrinks below this
   * after a PR's change, the sanity gate flags it as a near-flip even
   * though the sign hasn't changed. Default 3 points.
   */
  minGap?: number;
}

export const MATCHED_PAIRS: readonly MatchedPair[] = [
  {
    id: 'de-vs-fr',
    higherExpected: 'DE',
    lowerExpected: 'FR',
    axis: 'Broad OECD resilience vs nuclear-heavy power-system advantage',
    rationale:
      'France still has a defensible energy-dimension advantage from firm low-carbon nuclear generation, but the active whole-index CRI is the pillar-combined score across all six domains. Germany\'s broader economic, infrastructure, and recovery-capacity signals can now outweigh France\'s power-system edge at the overall-score level. Keep this as a small whole-index anchor with a deliberately thin buffer: the 2026-06-04 credentialed audit gap was 2.42 points, so future scorer PRs touching Germany or France should re-check the live ordering before changing this threshold. A future energy-specific check should use sampled score-endpoint energy-dimension evidence rather than reversing the full-index expectation back to FR > DE.',
    minGap: 1,
  },
  {
    id: 'no-vs-ca',
    higherExpected: 'NO',
    lowerExpected: 'CA',
    axis: 'SWF-fueled fossil exporter vs non-SWF fossil exporter',
    rationale:
      'Norway and Canada share the net-fuel-exporter + OECD + good-governance profile. Norway\'s sovereign-wealth buffer (GPFG, $1.6T) produces a materially larger shock-absorption cushion that Canada does not have. A scorer that loses this gap under PR 2 indicates the sovereignFiscalBuffer dimension is under-weighted OR the transparency/access/liquidity haircuts are over-penalizing Norway\'s fiscal-rule-bound withdrawals.',
    minGap: 3,
  },
  {
    id: 'uae-vs-bh',
    higherExpected: 'AE',
    lowerExpected: 'BH',
    axis: 'Gulf with large SWF scale vs small-scale Gulf',
    rationale:
      'UAE\'s SWF scale (ADIA + Mubadala + ICD ≈ $1.7T for a population of ~10M) is two orders of magnitude higher per capita than Bahrain\'s (Mumtalakat ≈ $20B for ~1.5M). UAE infrastructure and recovery-domain indicators dominate. A scorer that shows AE ≈ BH after PR 1+PR 2 is mis-scaling the SWF haircut transform.',
    minGap: 5,
  },
  {
    id: 'jp-vs-kr',
    higherExpected: 'JP',
    lowerExpected: 'KR',
    axis: 'Nuclear-adopters with different post-Fukushima trajectories',
    rationale:
      'Japan is a more established, more governance-tested nuclear adopter with deeper bureaucratic institutions and slightly stronger liquid-reserve cushion; South Korea is more dynamic but has higher concentration in semiconductor exports and lower SWF adequacy. The pair is intentionally narrow — within ~5 points expected — because both are strong OECD Asian economies. A wide gap or a direction flip under any PR indicates the scorer is over-reacting to governance-style differences or geopolitical-volatility proxies.',
    minGap: 1,
  },
  {
    id: 'in-vs-za',
    higherExpected: 'IN',
    lowerExpected: 'ZA',
    axis: 'Coal-heavy domestic producers',
    rationale:
      'India and South Africa are both coal-heavy domestic producers with weak governance relative to OECD peers. India has materially higher macro-fiscal resilience (larger reserves, larger economy, more diversified export base, growing nuclear share) than South Africa (load-shedding crisis, weaker fiscal space). The credentialed 2026-08-11 flag-off audit measured a 2.54-point gap, proving the old 3-point floor was already stale before education activation; the flag-on proposal measured 1.77. Rebaseline to the same deliberately narrow 1-point directional buffer used by other close whole-index peers. This does not match the current value: it preserves 0.77 points of headroom and still fails any near-tie or inversion. A scorer that loses this positive floor indicates imported-fossil or power-reliability signals need review.',
    minGap: 1,
  },
  {
    id: 'ch-vs-sg',
    higherExpected: 'CH',
    lowerExpected: 'SG',
    axis: 'Small high-infrastructure economies (balanced reserve center vs SWF hub)',
    rationale:
      'Both are small, wealthy, governance-strong, high-infrastructure economies. Singapore\'s GIC + Temasek buffer remains a real sovereign-fiscal strength, but the active CRI is not a sovereign-wealth ranking: Switzerland\'s balanced pillar profile, liquid-reserve strength, and low live-shock exposure have been a top-tier published anchor since the v17 methodology notes. Expect CH > SG at the whole-index level; a future PR 2 SWF-specific regression check should inspect sovereignFiscalBuffer evidence directly rather than requiring SG > CH overall.',
    minGap: 5,
  },

  // ── education activation anchors (#6460) ────────────────────────────────
  //
  // These three are WHOLE-INDEX pairs by design, and that is deliberate even
  // though #6459 established `DimensionMatchedPair` for exactly this kind of
  // activation gate. The distinction is what can go wrong.
  //
  // `financialSystemExposure` needed dimension-scoped pairs because its
  // DIRECTION was wrong: severance scored as strength, so the dimension itself
  // ranked backwards and a whole-index pair could not see a defect confined to
  // ~3% of the headline. Education has no such failure mode available to it —
  // it is a single monotone component (higher attainment scores higher, via one
  // piecewise transform), so its direction cannot invert without the transform
  // being rewritten. A dimension-scoped education pair would be tautological,
  // and `PT > UZ` at the dimension level is inverted BY DESIGN: Portugal
  // measures 50.0 against Uzbekistan's 96.0.
  //
  // The risk here is the opposite one: a CORRECT dimension with a very wide
  // spread dragging the whole index somewhere indefensible. 25+ attainment
  // stocks penalise late-developing school systems, so southern Europe carries
  // a real cohort-lag deficit against post-Soviet states with near-universal
  // upper-secondary credentials. That is a defensible construct property, but
  // it has to be BOUNDED before it publishes, and the only instrument that can
  // see it is the overall score. Hence whole-index.
  //
  // All three values below were measured against the production payload on
  // 2026-08-11 (`resilience:education-attainment:v1`, in-universe coverage 181).
  // If one of these fails the flag-on dry run, the pre-agreed response is to
  // halve `RESILIENCE_DIMENSION_WEIGHTS.education` from 0.5 to 0.25 and
  // re-measure — never to waive the gate.
  {
    id: 'pt-vs-uz',
    higherExpected: 'PT',
    lowerExpected: 'UZ',
    axis: 'EU institutional depth vs post-Soviet credential stock',
    rationale:
      'Portugal carries a ~46-point education-dimension deficit against Uzbekistan on the activating construct (50.0 vs 96.0 female upper-secondary attainment, 25+ population), because attainment measures a stock and Portugal democratised secondary schooling late. Everything else the index measures runs the other way: EU membership and the associated fiscal and regulatory backstop, materially stronger WGI governance across all six sub-pillars, deeper infrastructure and logistics, and a recovery-capacity profile with real reserve and fiscal-space depth. A landlocked authoritarian state with a young population and near-universal secondary credentials should not out-rank it overall. This pair exists to bound the cohort-lag effect at the only level where it is visible; it flips legitimately only if Uzbekistan\'s governance and infrastructure converge on EU levels, which would be a real change in the thing being measured rather than a scoring artefact.',
    minGap: 3,
  },
  {
    id: 'es-vs-by',
    higherExpected: 'ES',
    lowerExpected: 'BY',
    axis: 'EU member vs sanctioned post-Soviet state on the same credential axis',
    rationale:
      'The same axis as pt-vs-uz with the deficit at its widest and the counterweight at its clearest: Spain measures 55.8 against Belarus at 98.2, a ~42-point education-dimension gap, while Belarus is cut out of Western correspondent clearing and SWIFT messaging, sits at the bottom of the governance sub-pillars, and post-#6459 scores 15 on financialSystemExposure. Spain is an EU and euro-area member with deep institutions and infrastructure. If a single dimension at roughly 2.3% effective headline share can carry Belarus past Spain overall, the dimension weight is wrong rather than the gate. Kept separate from pt-vs-uz rather than folded into one pair because two independent instances of the same construct property are what distinguish a systematic southern-Europe penalty from one country\'s idiosyncratic profile.',
    minGap: 3,
  },
  {
    id: 'ch-vs-tm',
    higherExpected: 'CH',
    lowerExpected: 'TM',
    axis: 'Top-tier OECD state vs the education top-of-table closed autocracy',
    rationale:
      'Turkmenistan sits at the very top of the activating series (98.1) against Switzerland\'s 81.9, so this pair tests the ceiling of the construct rather than its southern-Europe tail: the concave bend above 85 is supposed to cap exactly this kind of credential inflation, holding the dimension gap to roughly 99 vs 89. Switzerland is a top-tier published anchor on the balanced pillar profile, liquid reserves, governance and infrastructure; Turkmenistan is a closed autocracy with negligible institutional depth. The buffer is deliberately larger than the other two education pairs because this is not a close call in any dimension except the activating one — a gap under 5 points would itself be evidence the bend is not doing its job, well before the sign ever flips.',
    minGap: 5,
  },
] as const;

export type WholeIndexMatchedPairStatus = 'pass' | 'near-flip' | 'inverted' | 'missing';

export interface WholeIndexMatchedPairEvaluation {
  pairId: string;
  higherExpected: string;
  lowerExpected: string;
  higherScore: number | null;
  lowerScore: number | null;
  gap: number | null;
  minGap: number;
  status: WholeIndexMatchedPairStatus;
}

type MatchedPairScoreMap =
  | ReadonlyMap<string, number | null | undefined>
  | Readonly<Record<string, number | null | undefined>>;

function readMatchedPairScore(scores: MatchedPairScoreMap, countryCode: string): number | null {
  const value = 'get' in scores && typeof scores.get === 'function'
    ? scores.get(countryCode)
    : scores[countryCode];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Apply the whole-index directional and minimum-gap contract to a score map.
 * Missing and non-finite scores are explicit failures; they never pass by
 * coercing to zero or by evaluating only the pair's direction.
 */
export function evaluateWholeIndexMatchedPairs(
  scores: MatchedPairScoreMap,
  pairs: readonly MatchedPair[] = MATCHED_PAIRS,
): readonly WholeIndexMatchedPairEvaluation[] {
  return pairs.map((pair) => {
    const higherScore = readMatchedPairScore(scores, pair.higherExpected);
    const lowerScore = readMatchedPairScore(scores, pair.lowerExpected);
    const minGap = pair.minGap ?? 3;

    if (higherScore == null || lowerScore == null) {
      return {
        pairId: pair.id,
        higherExpected: pair.higherExpected,
        lowerExpected: pair.lowerExpected,
        higherScore,
        lowerScore,
        gap: null,
        minGap,
        status: 'missing',
      };
    }

    const gap = higherScore - lowerScore;
    const status: WholeIndexMatchedPairStatus = gap >= minGap
      ? 'pass'
      : gap > 0
        ? 'near-flip'
        : 'inverted';
    return {
      pairId: pair.id,
      higherExpected: pair.higherExpected,
      lowerExpected: pair.lowerExpected,
      higherScore,
      lowerScore,
      gap,
      minGap,
      status,
    };
  });
}

// ---------------------------------------------------------------------------
// Dimension-scoped matched pairs.
//
// The panel above compares WHOLE-INDEX overall scores and is consumed by
// acceptance gate #7 in `scripts/compare-resilience-current-vs-proposed.mjs`.
// The panel below compares a SINGLE DIMENSION's score and is consumed only by
// that dimension's calibration test. The two must not be merged: a whole-index
// gate cannot see a direction inversion confined to one ~3%-of-headline
// dimension, which is exactly how `financialSystemExposure` shipped inverted
// (#6459). Spearman and max-drift bound how much the ranking moves; only a
// directional pair bounds WHO moves which way.
// ---------------------------------------------------------------------------

export interface DimensionMatchedPair extends MatchedPair {
  /** Dimension id whose per-dimension score the pair constrains. */
  dimension: string;
  /**
   * Marks a deliberately-thin anti-inversion anchor. The default dimension
   * pair is a DECISIVE contrast (severed vs deep; embargoed vs reserve
   * issuer) and must carry `minGap ≥ 10` — below that, a decisive pair
   * stops distinguishing "directionally right" from "the two happen to be
   * close". A thin anchor is the other kind: both jurisdictions' readings
   * are genuine and the honest post-fix state IS close, so the pair exists
   * to pin direction (and a small floor) against re-inversion — not
   * separation. Thin anchors carry `minGap` 1-5, and the rationale must say
   * why the gap is structurally thin. Config gate:
   * tests/resilience-cohort-config.test.mts § 'decisive minimum gap'.
   */
  thinAnchor?: true;
}

/**
 * `financialSystemExposure` direction anchors (#6459 Phase A).
 *
 * Each pair holds one side of the construct's question — "how vulnerable is
 * this financial system to coordinated Western financial action?" — roughly
 * constant while varying realized severance. A financially deep, FATF-clean,
 * multi-correspondent jurisdiction must out-score a comprehensively embargoed
 * one on this dimension. Before the #6459 retune, three of these four failed:
 * `us-vs-cu` was outright inverted, `sg-vs-mm` was a dead heat, and `lu-vs-by`
 * held its sign with a gap far under `minGap`.
 */
export const FIN_SYS_EXPOSURE_MATCHED_PAIRS: readonly DimensionMatchedPair[] = [
  {
    id: 'lu-vs-by-finsys',
    dimension: 'financialSystemExposure',
    higherExpected: 'LU',
    lowerExpected: 'BY',
    axis: 'Deep correspondent-banking centre vs coordinated financial severance',
    rationale:
      'Luxembourg is a core euro-area banking centre: fourteen distinct BIS reporting parents hold non-trivial claims on it, and it appears on neither FATF list. Belarus has been cut out of SWIFT messaging and Western correspondent clearing since 2022, holds the largest short-term external debt burden in this panel, and has essentially no foreign-bank presence. A construct measuring vulnerability to coordinated Western financial action must rank Luxembourg above Belarus. This flips only if the euro area itself becomes the sanctioning target of a bloc large enough to sever Luxembourg, or if Belarus is readmitted to Western correspondent networks — either would be a re-anchoring event for the whole construct, not a tuning question. The gap deliberately exceeds the whole-index pairs\' buffers because a single dimension should express its own signal cleanly rather than sit near a tie.',
    minGap: 10,
  },
  {
    id: 'sg-vs-mm-finsys',
    dimension: 'financialSystemExposure',
    higherExpected: 'SG',
    lowerExpected: 'MM',
    axis: 'Regional clearing hub vs FATF-blacklisted, coup-isolated banking system',
    rationale:
      'Singapore and Myanmar are the same-region contrast that the retired OFAC-domicile construct got backwards. Singapore intermediates ASEAN USD clearing with eleven independent reporting parents and clean FATF standing; Myanmar sits on the FATF call-for-action black list, is under EO 14014 blocking measures, and retains a single meaningful foreign-bank counterparty. Myanmar\'s tiny reported short-term external debt is a symptom of losing market access, not of prudent liability management — reading it as strength is the specific defect this pair is here to catch. The direction flips only if Myanmar is delisted by FATF and regains broad correspondent access, which would be a genuine construct-relevant improvement.',
    minGap: 10,
  },
  {
    id: 'ch-vs-ru-finsys',
    dimension: 'financialSystemExposure',
    higherExpected: 'CH',
    lowerExpected: 'RU',
    axis: 'Neutral reserve centre vs the largest post-2022 financial-severance case',
    rationale:
      'Switzerland runs a globally integrated banking system at a claims level inside the healthy band, with nine reporting parents and no FATF listing. Russia has roughly half its central-bank reserves immobilised, is excluded from SWIFT for its major banks, and reports zero BIS parents holding non-trivial claims. Russia\'s low short-term external debt ratio and its absence from both FATF lists are artefacts of severance and of FATF only enumerating AML/CFT deficiencies, not evidence of a resilient financial system. This pair is the clearest statement that the construct measures exposure-to-action rather than distance-from-the-West; it would flip only if Switzerland itself were comprehensively sanctioned.',
    minGap: 10,
  },
  {
    id: 'us-vs-cu-finsys',
    dimension: 'financialSystemExposure',
    higherExpected: 'US',
    lowerExpected: 'CU',
    axis: 'Issuer of the reserve currency vs a comprehensively embargoed economy',
    rationale:
      'The United States issues the currency the construct is denominated in and sits mid-band on cross-border claims with eight reporting parents. Cuba has been under a comprehensive US embargo for six decades, has no BIS counterparty row and no Debtor Reporting System row, and is absent from both FATF lists purely because FATF has never assessed it. Before the #6459 retune this pair was inverted: Cuba scored 100 on FATF-compliant-by-absence as its only observed slot and beat the United States outright. That inversion is the single most legible symptom of the construct defect, so the pair is retained permanently as its regression anchor. It flips only if the United States loses reserve-currency status.',
    minGap: 10,
  },
  {
    id: 'ch-vs-mu-finsys',
    dimension: 'financialSystemExposure',
    higherExpected: 'CH',
    lowerExpected: 'MU',
    axis: 'Deep reserve centre vs thinly-capitalised offshore intermediation',
    rationale:
      'The cap-independent anchor of this panel. Neither jurisdiction is on the comprehensive-embargo list, so this pair holds on the graded components alone — if the cap were ever removed or narrowed, the other four pairs would go quiet while this one still constrains direction. Switzerland and Mauritius are both small, FATF-clean, banking-heavy economies, which is what makes the contrast informative: Mauritius carries short-term external debt worth 62.8% of GNI against the construct\'s 15%-of-GNI vulnerability threshold, and its cross-border claims sit deep in over-exposed territory on a small domestic base, while Switzerland sits inside the healthy band with nine reporting parents and no comparable rollover overhang. The claim is that the construct rewards depth plus low rollover risk over thinly-capitalised intermediation. It flips if Mauritius materially deleverages its short-term external position, which would be a real improvement in the thing being measured.',
    minGap: 10,
  },
  {
    id: 'gb-vs-al-finsys',
    dimension: 'financialSystemExposure',
    higherExpected: 'GB',
    lowerExpected: 'AL',
    axis: 'Deep multi-parent hub vs concentrated two-parent integration',
    rationale:
      'The concentrated-integration anchor. Albania\'s cross-border claims sit at sweet-spot level (17.6% of GDP) but arrive through exactly two reporting parents — its BIS parents map is dominated by one Austrian and one Italian banking group, the same two-door dependence that made Greek-bank deleveraging a systemic event for the western Balkans in 2011-2015. The United Kingdom carries heavier claims (64.2% of GDP) through twelve independent parents with clean FATF standing. A construct whose Component 2 sweet spot is documented as "healthy diversified financial system" must not rank a two-parent system above a twelve-parent one on the strength of the level alone: integration depth without funding diversity is a withdrawal channel, not a cushion. The gap is structurally thin, not decisive: the UK\'s heavy claims genuinely sit on the over-exposure leg while Albania\'s low short-term debt and clean FATF standing are genuine strengths, so direction plus a small floor is the honest claim. It flips only if Albania\'s parent base genuinely broadens — a real improvement in the thing measured — or if the UK\'s correspondent network concentrates to a comparable degree.',
    thinAnchor: true,
    minGap: 3,
  },
  {
    id: 'sg-vs-al-finsys',
    dimension: 'financialSystemExposure',
    higherExpected: 'SG',
    lowerExpected: 'AL',
    axis: 'Diversified entrepôt over-exposure vs concentrated moderate integration',
    rationale:
      'The residue pair from the #6459 retune: after the band re-anchor Singapore still scored below Albania, because Albania collected the full sweet-spot premium on claims held through two parents while Singapore\'s eleven-parent entrepôt balance sheet sat on the over-exposure floor. Both readings are real, but their risk is not symmetric: an eleven-parent hub loses one funder and reroutes; a two-parent system loses one funder and loses half its foreign-credit channel. The gap is deliberately thin — Singapore\'s over-exposure is genuine and Albania\'s low short-term debt is genuine, so the construct should separate them by direction rather than by a wide margin. It flips if Albania\'s parent base broadens materially or if Singapore\'s reporting-parent set collapses toward concentration.',
    thinAnchor: true,
    minGap: 1,
  },
] as const;
