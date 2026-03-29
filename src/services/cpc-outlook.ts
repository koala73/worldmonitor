/**
 * NOAA Climate Prediction Center (CPC) seasonal outlooks and climate assessments
 * Data sources: NWS Products API (direct — CORS enabled)
 * Products: RCM (Regional Climate Monthly), HLS (Seasonal Hazard), REC (Record Events)
 */

export type ClimateOutlookType =
  | 'monthly-discussion'
  | 'seasonal-hazard'
  | 'climate-assessment'
  | 'drought-outlook'
  | 'temperature-outlook'
  | 'precipitation-outlook';

export interface ClimateOutlook {
  id: string;
  title: string;
  summary: string;
  outlookType: ClimateOutlookType;
  issuingOffice: string;
  issuanceTime: Date;
  url: string;
  signals: string[];
  severity: 'critical' | 'high' | 'medium' | 'low';
}

const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours — updates daily/weekly
let cache: { data: ClimateOutlook[]; ts: number } | null = null;

const NWS_PRODUCTS_BASE = 'https://api.weather.gov/products';

interface NWSProductListItem {
  '@id'?: string;
  productCode?: string;
  productName?: string;
  issuingOffice?: string;
  issuanceTime?: string;
}

interface NWSProductListResponse {
  '@graph'?: NWSProductListItem[];
}

interface NWSProductText {
  '@id'?: string;
  productCode?: string;
  productName?: string;
  issuingOffice?: string;
  issuanceTime?: string;
  productText?: string;
}

async function fetchProductList(type: string, limit: number): Promise<NWSProductListItem[]> {
  try {
    const url = `${NWS_PRODUCTS_BASE}?type=${type}&limit=${limit}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/ld+json' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return [];
    const json: NWSProductListResponse = await res.json();
    return json['@graph'] ?? [];
  } catch {
    return [];
  }
}

async function fetchProductText(id: string): Promise<NWSProductText | null> {
  try {
    const res = await fetch(id, {
      headers: { Accept: 'application/ld+json' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as NWSProductText;
  } catch {
    return null;
  }
}

function extractSignals(text: string): string[] {
  const lower = text.toLowerCase();
  const signals: string[] = [];

  if (/above[\s-]normal temp(?:erature)?|above[\s-]normal heat/i.test(text)) {
    signals.push('Above normal temperatures');
  }
  if (/below[\s-]normal temp(?:erature)?|well below[\s-]normal/i.test(text)) {
    signals.push('Below normal temperatures');
  }
  if (/drought develop|drought intensif|drought persist|exceptional drought/i.test(text)) {
    signals.push('Drought development or intensification');
  } else if (lower.includes('drought')) {
    signals.push('Drought conditions');
  }
  if (/above[\s-]normal precip(?:itation)?|well above[\s-]normal precip/i.test(text)) {
    signals.push('Above normal precipitation');
  }
  if (/below[\s-]normal precip(?:itation)?/i.test(text)) {
    signals.push('Below normal precipitation');
  }
  if (/enhanced fire weather|critical fire weather/i.test(text)) {
    signals.push('Enhanced fire weather risk');
  }
  if (/flooding concern|above[\s-]normal streamflow/i.test(text)) {
    signals.push('Flooding concern');
  }
  if (/La Ni[ñn]a/i.test(text)) {
    signals.push('La Niña influence');
  } else if (/El Ni[ñn]o/i.test(text)) {
    signals.push('El Niño influence');
  }

  return signals;
}

function detectOutlookType(
  productCode: string,
  productText: string,
): ClimateOutlookType {
  const code = (productCode ?? '').toUpperCase();
  const lower = productText.toLowerCase();

  // Drought check takes precedence for any product mentioning drought prominently
  if (lower.includes('drought')) return 'drought-outlook';

  switch (code) {
    case 'RCM': { return 'monthly-discussion';
    }
    case 'HLS': { return 'seasonal-hazard';
    }
    case 'REC': { return 'climate-assessment';
    }
    case 'CCD': { return 'climate-assessment';
    }
    default: {
      if (/temperature/i.test(productText)) return 'temperature-outlook';
      if (/precipitation/i.test(productText)) return 'precipitation-outlook';
      return 'monthly-discussion';
    }
  }
}

function computeOutlookSeverity(
  outlookType: ClimateOutlookType,
  productText: string,
  signals: string[],
): ClimateOutlook['severity'] {
  const lower = productText.toLowerCase();

  if (outlookType === 'drought-outlook' && lower.includes('exceptional')) return 'critical';
  if (outlookType === 'seasonal-hazard' && lower.includes('major hazard')) return 'high';
  if (signals.some((s) => /drought|fire weather|flooding/i.test(s))) return 'high';
  if (signals.length > 2) return 'medium';
  if (signals.length > 0) return 'medium';
  return 'low';
}

function safeDate(raw: string | null | undefined): Date {
  if (!raw) return new Date();
  const d = new Date(raw);
  return isNaN(d.getTime()) ? new Date() : d;
}

async function processProductList(
  items: NWSProductListItem[],
  maxFetch: number,
): Promise<ClimateOutlook[]> {
  const toFetch = items.slice(0, maxFetch);
  const textResults = await Promise.allSettled(
    toFetch.map((item) => (item['@id'] ? fetchProductText(item['@id']) : Promise.resolve(null))),
  );

  const results: ClimateOutlook[] = [];
  const now = Date.now();
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;

  for (const [i, item] of toFetch.entries()) {
    const textResult = textResults[i];
    if (!item || textResult?.status !== 'fulfilled' || !textResult.value) continue;

    const product = textResult.value;
    const issuanceTime = safeDate(item.issuanceTime ?? product.issuanceTime);
    if (issuanceTime.getTime() < cutoff) continue;

    const productText = product.productText ?? '';
    const productCode = item.productCode ?? product.productCode ?? '';
    const productName = item.productName ?? product.productName ?? productCode;

    const signals = extractSignals(productText);
    const outlookType = detectOutlookType(productCode, productText);
    const severity = computeOutlookSeverity(outlookType, productText, signals);

    const summary = productText.replace(/\s{2,}/g, ' ').trim().slice(0, 400);

    results.push({
      id: `cpc-${productCode}-${issuanceTime.getTime()}`,
      title: productName,
      summary,
      outlookType,
      issuingOffice: item.issuingOffice ?? product.issuingOffice ?? '',
      issuanceTime,
      url: item['@id'] ?? '',
      signals,
      severity,
    });
  }

  return results;
}

const SEVERITY_ORDER: Record<ClimateOutlook['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export async function fetchCpcOutlooks(): Promise<ClimateOutlook[]> {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) return cache.data;

  // Fetch product lists in parallel
  const [rcmResult, hlsResult, recResult] = await Promise.allSettled([
    fetchProductList('RCM', 5),
    fetchProductList('HLS', 5),
    fetchProductList('REC', 5),
  ]);

  const rcmItems = rcmResult.status === 'fulfilled' ? rcmResult.value : [];
  const hlsItems = hlsResult.status === 'fulfilled' ? hlsResult.value : [];
  const recItems = recResult.status === 'fulfilled' ? recResult.value : [];

  // Fetch product texts in parallel across all lists (up to 2 per list)
  const [rcmOutlooks, hlsOutlooks, recOutlooks] = await Promise.allSettled([
    processProductList(rcmItems, 2),
    processProductList(hlsItems, 2),
    processProductList(recItems, 2),
  ]);

  const all: ClimateOutlook[] = [
    ...(rcmOutlooks.status === 'fulfilled' ? rcmOutlooks.value : []),
    ...(hlsOutlooks.status === 'fulfilled' ? hlsOutlooks.value : []),
    ...(recOutlooks.status === 'fulfilled' ? recOutlooks.value : []),
  ];

  if (all.length === 0) return cache?.data ?? [];

  all.sort((a, b) => {
    const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sev !== 0) return sev;
    return b.issuanceTime.getTime() - a.issuanceTime.getTime();
  });

  const data = all.slice(0, 15);
  cache = { data, ts: Date.now() };
  return data;
}

export function cpcSeverityClass(severity: ClimateOutlook['severity']): string {
  switch (severity) {
    case 'critical': { return 'eq-row eq-major';
    }
    case 'high': { return 'eq-row eq-strong';
    }
    case 'medium': { return 'eq-row eq-moderate';
    }
    case 'low': { return 'eq-row';
    }
  }
}
