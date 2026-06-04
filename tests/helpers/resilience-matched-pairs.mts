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
      'India and South Africa are both coal-heavy domestic producers with weak governance relative to OECD peers. India has materially higher macro-fiscal resilience (larger reserves, larger economy, more diversified export base, growing nuclear share) than South Africa (load-shedding crisis, weaker fiscal space). A scorer that loses this gap after PR 1 indicates the importedFossilDependence composite is over-crediting South Africa for its domestic coal without weighting its power-system-reliability collapse.',
    minGap: 3,
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
] as const;
