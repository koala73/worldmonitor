// Canada national-statistics overlay for the Country Resilience Index.
// IMF WEO is annual and lagged; Bank of Canada Valet and Statistics Canada
// WDS replace the CA placeholders with the series those seeders actually publish.

export const RESILIENCE_BOC_VALET_KEY = 'economic:boc-valet:v1';
export const RESILIENCE_STATCAN_WDS_KEY = 'economic:statcan-wds:v1';

export type ImfMacroLike = {
  inflationPct?: number | null;
  currentAccountPct?: number | null;
  govRevenuePct?: number | null;
  year?: number | null;
};

export type ImfLaborLike = {
  unemploymentPct?: number | null;
  populationMillions?: number | null;
  year?: number | null;
};

export type StatcanWdsPayload = {
  inflationPct?: number | null;
  inflationRefPer?: string | null;
  unemploymentPct?: number | null;
  unemploymentRefPer?: string | null;
};

export type BocValetPayload = {
  rates?: Record<string, { rate?: number; date?: string }>;
  policyRate?: { rate?: number; observedAt?: string } | null;
};

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Prefer Statistics Canada monthly CPI / LFS over lagged IMF WEO for CA.
 * Bank of Canada Valet is required reading so the FX + overnight-target key
 * is not an unread Redis write: USD/CAD and the policy rate ride on the
 * overlay for currencyExternal consumers.
 */
export function applyCanadaNationalOverlay(
  countryCode: string,
  imfEntry: ImfMacroLike | null,
  laborEntry: ImfLaborLike | null,
  sources: { statcan?: StatcanWdsPayload | null; boc?: BocValetPayload | null },
): {
  imfEntry: ImfMacroLike | null;
  laborEntry: ImfLaborLike | null;
  usedStatcanInflation: boolean;
  usedStatcanUnemployment: boolean;
  bocUsdCad: number | null;
  bocPolicyRate: number | null;
} {
  if (countryCode !== 'CA') {
    return {
      imfEntry,
      laborEntry,
      usedStatcanInflation: false,
      usedStatcanUnemployment: false,
      bocUsdCad: null,
      bocPolicyRate: null,
    };
  }

  const statcanInflation = finiteOrNull(sources.statcan?.inflationPct);
  const statcanUnemployment = finiteOrNull(sources.statcan?.unemploymentPct);
  const bocUsdCad = finiteOrNull(sources.boc?.rates?.USD?.rate);
  const bocPolicyRate = finiteOrNull(sources.boc?.policyRate?.rate);

  const nextImf: ImfMacroLike | null = imfEntry || statcanInflation != null
    ? {
        ...(imfEntry ?? {}),
        ...(statcanInflation != null ? { inflationPct: statcanInflation } : {}),
      }
    : null;
  const nextLabor: ImfLaborLike | null = laborEntry || statcanUnemployment != null
    ? {
        ...(laborEntry ?? {}),
        ...(statcanUnemployment != null ? { unemploymentPct: statcanUnemployment } : {}),
      }
    : null;

  return {
    imfEntry: nextImf,
    laborEntry: nextLabor,
    usedStatcanInflation: statcanInflation != null,
    usedStatcanUnemployment: statcanUnemployment != null,
    bocUsdCad,
    bocPolicyRate,
  };
}
