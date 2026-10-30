/**
 * Hormuz bypass recovery by exporter, for the oil shock model.
 *
 * Three exporters can move crude around a closed Strait of Hormuz:
 * - Saudi Arabia, by the East-West pipeline to the Yanbu terminals.
 * - The UAE, by ADCOP to Fujairah.
 * - Iraq, for northern crude only, by Kirkuk-Ceyhan.
 * Kuwait, Qatar, Bahrain and Iran have no bypass (Iran's Goreh-Jask terminal
 * has not loaded since Sep 2024).
 *
 * Fields per exporter:
 * - `hormuzShare`: the share of the exporter's crude that loads inside the
 *   Strait before any disruption. The rest already leaves via Yanbu,
 *   Fujairah or Ceyhan.
 * - `recovery`: the share of that Hormuz-routed crude the bypass can reroute.
 *
 * Both are hand-maintained figures derived from the sources listed. They are
 * not measured flows: PortWatch AIS port data cannot measure them, because
 * Yanbu tankers have run AIS-dark since Aug 2026. Revise the values and
 * HORMUZ_BYPASS_AS_OF together.
 */

export const HORMUZ_BYPASS_AS_OF = '2026-10-28';

/**
 * Rerouting ramps up over about two months: Japan's crude imports fell 65% in
 * Apr 2026 and recovered by Jun-Jul (METI). A linear 2-month ramp loses the same
 * cumulative volume as one month at the no-bypass rate, which is what the
 * model charges.
 */
export const BYPASS_RAMP_DAYS = 30;

export type BypassScenario = 'low' | 'central' | 'high';

export interface BypassRecovery {
  hormuzShare: number;
  recovery: Record<BypassScenario, number>;
  route: string;
  basis: string;
  sources: string[];
}

export const HORMUZ_BYPASS_BY_EXPORTER: Readonly<Record<'SA' | 'AE' | 'IQ', BypassRecovery>> = {
  SA: {
    hormuzShare: 0.85,
    recovery: { low: 0.45, central: 0.65, high: 0.75 },
    route: 'East-West pipeline to Yanbu',
    basis: 'The binding limit is the Yanbu crude terminals at about 4.5-5 mb/d, not the 7 mb/d pipe. Less about 0.9 mb/d of pre-war Yanbu loadings, that is spare capacity for about 65% of the ~5.5 mb/d of Hormuz-routed Saudi crude. The low case is the Aug 2026 level (3.2 mb/d) under Red Sea threats.',
    sources: [
      'https://www.eia.gov/todayinenergy/detail.php?id=65504',
      'https://english.alarabiya.net/amp/business/energy/2026/03/28/saudi-pipeline-that-bypasses-strait-of-hormuz-hits-7millionbarrel-goal',
      'https://www.kpler.com/blog/new-pipelines-bypassing-the-strait-of-hormuz-could-come-online-in-1-2-years',
      'https://www.businessday.co.za/world/2026-09-10-hormuz-shipping-traffic-down-to-single-digits-data-shows/',
    ],
  },
  AE: {
    hormuzShare: 0.65,
    recovery: { low: 0.2, central: 0.3, high: 0.35 },
    route: 'ADCOP pipeline to Fujairah',
    basis: 'ADCOP carries about 1.8 mb/d against about 1.07 mb/d of pre-war use. That spare capacity covers about 30% of the ~2.2 mb/d of Hormuz-routed UAE crude. Fujairah already shipped about 1.1 of 3.2-3.4 mb/d before the crisis.',
    sources: [
      'https://www.eia.gov/todayinenergy/detail.php?id=65504',
      'https://worldoil.com/news/2026/3/27/uae-boosts-fujairah-oil-exports-as-hormuz-disruption-redirects-crude-flows/',
      'https://www.thenationalnews.com/business/energy/2026/08/03/uaes-hormuz-oil-exports-more-than-halve-in-july-as-tankers-avoid-route/',
    ],
  },
  IQ: {
    hormuzShare: 0.95,
    recovery: { low: 0.05, central: 0.1, high: 0.15 },
    route: 'Kirkuk-Ceyhan pipeline',
    basis: 'Kirkuk-Ceyhan carries northern crude only: about 180 kb/d in Jun 2026, against a 750 kb/d deal ceiling. Basra crude cannot reach the pipeline in volume.',
    sources: [
      'https://english.aawsat.com/node/5295804',
      'https://www.turkiyetoday.com/business/turkiye-iraq-sign-one-year-deal-to-lift-kirkuk-oil-flow-to-750000-bpd-3225136',
    ],
  },
};

export interface GulfShareByExporter {
  /** Gulf (SA, AE, IQ, KW, IR, QA, BH) share of the importer's crude imports. */
  gulfShare: number;
  /** Share of the importer's crude imports from each exporter with a bypass; missing means 0. */
  byPartner: Partial<Record<string, number>>;
}

/**
 * Fraction of the importer's crude imports lost when `disruption` (0..1) of
 * Hormuz traffic stops, after bypass rerouting at steady state. Allocation is
 * pro rata: every buyer of an exporter keeps the same fraction of its cargoes.
 * Rerouting is capacity-limited, so an exporter loses only the Hormuz-routed
 * volume above what its bypass can carry: hormuzShare * max(0, d - recovery).
 */
export function lostShareAfterBypass(
  { gulfShare, byPartner }: GulfShareByExporter,
  disruption: number,
  scenario: BypassScenario,
): number {
  const d = Math.max(0, Math.min(1, disruption));
  let bypassable = 0;
  let lost = 0;
  for (const [iso2, b] of Object.entries(HORMUZ_BYPASS_BY_EXPORTER)) {
    const share = byPartner[iso2];
    if (typeof share !== 'number' || !Number.isFinite(share) || share <= 0) continue;
    bypassable += share;
    lost += share * b.hormuzShare * Math.max(0, d - b.recovery[scenario]);
  }
  return Math.max(0, gulfShare - bypassable) * d + lost;
}
