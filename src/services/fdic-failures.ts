/**
 * FDIC Bank Failure Tracker
 * Source: https://banks.data.fdic.gov/api/failures (free, public, CORS-enabled)
 */

export type BankResolutionType = 'purchase-assumption' | 'payout' | 'open-bank-assistance' | 'other';

export interface BankFailure {
  id: string;
  institutionName: string;
  city: string;
  state: string;
  certNumber: number;
  failureDate: Date;
  totalAssetsM: number; // in millions (QBFASSET / 1000)
  totalDepositsM: number; // in millions
  costToFdicM: number; // in millions
  resolutionType: BankResolutionType;
  bankType: 'commercial' | 'savings' | 'other';
  severity: 'critical' | 'high' | 'medium' | 'low';
}

export interface FdicFailureSummary {
  failures: BankFailure[];
  totalFailuresLastYear: number;
  totalAssetsCoveredM: number;
  fetchedAt: Date;
}

interface FdicRawItem {
  data: {
    INSTNAME?: string;
    CITY?: string;
    STALP?: string;
    CERT?: number;
    FAILDATE?: string;
    QBFASSET?: number;
    QBFDEP?: number;
    COST?: number;
    RESTYPE?: string;
    SAVR?: string;
    CHARTER?: string;
  };
}

interface FdicResponse {
  data: FdicRawItem[];
}

const FDIC_API_URL =
  'https://banks.data.fdic.gov/api/failures?limit=25&sort_by=FAILDATE&sort_order=DESC&output=json&fields=INSTNAME,CITY,STALP,CERT,SAVR,RESTYPE,FAILDATE,QBFASSET,QBFDEP,COST,CHARTER';

const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
let cache: { data: FdicFailureSummary; ts: number } | null = null;

function parseFailDate(dateStr: string): Date {
  // FAILDATE is "YYYYMMDD"
  return new Date(
    parseInt(dateStr.slice(0, 4), 10),
    parseInt(dateStr.slice(4, 6), 10) - 1,
    parseInt(dateStr.slice(6, 8), 10),
  );
}

function parseResolutionType(restype: string | undefined): BankResolutionType {
  if (!restype) return 'other';
  const t = restype.toUpperCase().replace(/\s/g, '');
  if (t === 'P&A' || t === 'PA') return 'purchase-assumption';
  if (t === 'PO') return 'payout';
  if (t === 'OA') return 'open-bank-assistance';
  return 'other';
}

function parseBankType(savr: string | undefined): 'commercial' | 'savings' | 'other' {
  if (!savr) return 'other';
  const s = savr.toUpperCase();
  if (s === 'CB') return 'commercial';
  if (s === 'SB') return 'savings';
  return 'other';
}

function computeSeverity(totalAssetsM: number): BankFailure['severity'] {
  if (totalAssetsM > 10000) return 'critical';
  if (totalAssetsM > 1000) return 'high';
  if (totalAssetsM > 100) return 'medium';
  return 'low';
}

export async function fetchBankFailures(): Promise<FdicFailureSummary> {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_TTL_MS) return cache.data;

  try {
    const res = await fetch(FDIC_API_URL, {
      signal: AbortSignal.timeout(12000),
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) {
      return cache?.data ?? { failures: [], totalFailuresLastYear: 0, totalAssetsCoveredM: 0, fetchedAt: new Date() };
    }

    const json: FdicResponse = await res.json();
    const twoYearsAgo = new Date(now - 2 * 365 * 24 * 60 * 60 * 1000);
    const oneYearAgo = new Date(now - 365 * 24 * 60 * 60 * 1000);

    const failures: BankFailure[] = (json.data ?? [])
      .map((item) => {
        const d = item.data;
        const certNumber = d.CERT ?? 0;
        const failureDate = d.FAILDATE ? parseFailDate(d.FAILDATE) : new Date(0);
        const totalAssetsM = (d.QBFASSET ?? 0) / 1000;
        const totalDepositsM = (d.QBFDEP ?? 0) / 1000;
        const costToFdicM = (d.COST ?? 0) / 1000;
        const resolutionType = parseResolutionType(d.RESTYPE);
        const bankType = parseBankType(d.SAVR);
        const severity = computeSeverity(totalAssetsM);

        return {
          id: `fdic-${certNumber}-${d.FAILDATE ?? '0'}`,
          institutionName: d.INSTNAME ?? 'Unknown Institution',
          city: d.CITY ?? '',
          state: d.STALP ?? '',
          certNumber,
          failureDate,
          totalAssetsM,
          totalDepositsM,
          costToFdicM,
          resolutionType,
          bankType,
          severity,
        };
      })
      .filter((f) => f.failureDate >= twoYearsAgo)
      .sort((a, b) => b.failureDate.getTime() - a.failureDate.getTime())
      .slice(0, 25);

    const totalFailuresLastYear = failures.filter((f) => f.failureDate >= oneYearAgo).length;
    const totalAssetsCoveredM = failures.reduce((sum, f) => sum + f.totalAssetsM, 0);

    const summary: FdicFailureSummary = {
      failures,
      totalFailuresLastYear,
      totalAssetsCoveredM,
      fetchedAt: new Date(),
    };

    cache = { data: summary, ts: now };
    return summary;
  } catch {
    return (
      cache?.data ?? { failures: [], totalFailuresLastYear: 0, totalAssetsCoveredM: 0, fetchedAt: new Date() }
    );
  }
}

export function bankFailureSeverityClass(severity: BankFailure['severity']): string {
  switch (severity) {
    case 'critical':
      return 'eq-row eq-major';
    case 'high':
      return 'eq-row eq-strong';
    case 'medium':
      return 'eq-row eq-moderate';
    case 'low':
      return 'eq-row';
    default:
      return 'eq-row';
  }
}
