/**
 * Strategic crude reserves of importers outside the IEA, as dated estimates.
 *
 * India and China file no stock data to the IEA, so the oil shock had no cover
 * figure for them. These ranges are reported as estimates wherever they are
 * used, and never as IEA data:
 * - `scope`: what the figure counts.
 * - `asOf`: when the stock was measured or estimated.
 * - `credibility`: how far to trust it.
 * Revise the values with each new parliamentary reply or EIA note.
 */

export interface ReserveEstimateSource {
  /** Million barrels of crude. */
  lowMb: number;
  centralMb: number;
  highMb: number;
  /** Date of the stock figure: YYYY-MM-DD or YYYY-MM. */
  asOf: string;
  scope: string;
  /** "high": an official stock statement. "low": an outside estimate of undisclosed stocks. */
  credibility: 'high' | 'low';
  basis: string;
  sources: string[];
}

export const NON_IEA_RESERVES: Readonly<Record<'IN' | 'CN', ReserveEstimateSource>> = {
  IN: {
    lowMb: 21.4,
    centralMb: 24,
    highMb: 39,
    asOf: '2026-03-23',
    scope: 'ISPRL strategic reserve (Vizag, Mangaluru, Padur); commercial stocks are not counted',
    credibility: 'high',
    basis: 'Central: 3.372 MMT held on 23 Mar 2026 (64% of the 5.33 MMT capacity), about 24 M bbl at 7.13 bbl/t, per a Rajya Sabha reply. Low: EIA\'s 21.4 M bbl for Mar 2025. High: the full 39 M bbl capacity. India opted out of the Mar 2026 IEA release and has published no fill since.',
    sources: [
      'https://visionias.in/current-affairs/news-today/2026-03-25/economy/indias-strategic-petroleum-reserves-sprs-about-two-thirds-full-union-minister',
    ],
  },
  CN: {
    lowMb: 360,
    centralMb: 1200,
    highMb: 1400,
    asOf: '2025-12',
    scope: 'government reserve (low) up to government plus state-directed commercial crude stocks (high)',
    credibility: 'low',
    basis: 'Low and high: EIA balance-method estimates for Dec 2025, about 360 M bbl government-held and about 1.4 bn bbl including the commercial stocks state firms were told to hold. Central: a WorldMonitor judgment of 1.2 bn bbl, below EIA\'s upper figure for unquantified 2026 draws; EIA gives no central value. China publishes no stock data. Vortexa put state-controlled onshore stocks at 735 M bbl in late 2025, and 2026 draws are unquantified.',
    sources: [
      'https://www.eia.gov/todayinenergy/detail.php?id=67504',
    ],
  },
};

export function nonIeaReserveFor(iso2: string): ReserveEstimateSource | undefined {
  return (NON_IEA_RESERVES as Record<string, ReserveEstimateSource | undefined>)[iso2];
}
