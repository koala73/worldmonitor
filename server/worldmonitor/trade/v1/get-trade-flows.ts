/**
 * RPC: getTradeFlows -- WTO merchandise trade flow data
 * Fetches bilateral export/import values and computes YoY changes.
 *
 * NOTE: The WTO API does NOT support comma-separated indicator codes.
 * Exports and imports must be fetched in separate requests.
 */

declare const process: { env: Record<string, string | undefined> };

import type {
  ServerContext,
  GetTradeFlowsRequest,
  GetTradeFlowsResponse,
  TradeFlowRecord,
} from '../../../../src/generated/server/worldmonitor/trade/v1/service_server';

import { cachedFetchJson } from '../../../_shared/redis';
import { wtoFetch, WTO_MEMBER_CODES, ITS_MTV_AX, ITS_MTV_AM } from './_shared';

const REDIS_CACHE_TTL = 21600; // 6h — WTO data is annual, rarely changes

/**
 * Validate a country code string — alphanumeric, max 10 chars.
 */
function isValidCode(c: string): boolean {
  return /^[a-zA-Z0-9]{1,10}$/.test(c);
}

interface RawFlowRow {
  year: number;
  indicator: string;
  value: number;
}

/**
 * Parse raw WTO rows into a flat list of { year, indicator, value }.
 */
function parseRows(data: any, indicator: string): RawFlowRow[] {
  const dataset: any[] = Array.isArray(data) ? data : data?.Dataset ?? data?.dataset ?? [];
  const rows: RawFlowRow[] = [];

  for (const row of dataset) {
    const year = parseInt(row.Year ?? row.year ?? row.Period ?? '', 10);
    const value = parseFloat(row.Value ?? row.value ?? '');
    if (!isNaN(year) && !isNaN(value)) {
      rows.push({ year, indicator, value });
    }
  }

  return rows;
}

/**
 * Build trade flow records from export + import rows, computing YoY changes.
 */
function buildFlowRecords(
  rows: RawFlowRow[],
  reporter: string,
  partner: string,
): TradeFlowRecord[] {
  // Group by year
  const byYear = new Map<number, { exports: number; imports: number }>();

  for (const row of rows) {
    if (!byYear.has(row.year)) {
      byYear.set(row.year, { exports: 0, imports: 0 });
    }
    const entry = byYear.get(row.year)!;
    if (row.indicator === ITS_MTV_AX) {
      entry.exports = row.value;
    } else if (row.indicator === ITS_MTV_AM) {
      entry.imports = row.value;
    }
  }

  // Sort by year ascending
  const sortedYears = Array.from(byYear.keys()).sort((a, b) => a - b);

  const records: TradeFlowRecord[] = [];
  for (let i = 0; i < sortedYears.length; i++) {
    const year = sortedYears[i]!;
    const current = byYear.get(year)!;
    const prev = i > 0 ? byYear.get(sortedYears[i - 1]!) : null;

    let yoyExportChange = 0;
    let yoyImportChange = 0;

    if (prev && prev.exports > 0) {
      yoyExportChange = Math.round(((current.exports - prev.exports) / prev.exports) * 10000) / 100;
    }
    if (prev && prev.imports > 0) {
      yoyImportChange = Math.round(((current.imports - prev.imports) / prev.imports) * 10000) / 100;
    }

    records.push({
      reportingCountry: WTO_MEMBER_CODES[reporter] ?? reporter,
      partnerCountry: WTO_MEMBER_CODES[partner] ?? partner,
      year,
      exportValueUsd: current.exports,
      importValueUsd: current.imports,
      yoyExportChange,
      yoyImportChange,
      productSector: 'Total merchandise',
    });
  }

  return records;
}

async function fetchTradeFlows(
  reporter: string,
  partner: string,
  years: number,
): Promise<{ flows: TradeFlowRecord[]; ok: boolean }> {
  const currentYear = new Date().getFullYear();
  const startYear = currentYear - years;

  const baseParams: Record<string, string> = {
    r: reporter,
    p: partner || '000',
    ps: `${startYear}-${currentYear}`,
    pc: 'TO',
    fmt: 'json',
    mode: 'full',
    max: '500',
  };

  // Fetch exports and imports in parallel (separate requests — WTO API doesn't support comma-separated indicators)
  const [exportsData, importsData] = await Promise.all([
    wtoFetch('/data', { ...baseParams, i: ITS_MTV_AX }),
    wtoFetch('/data', { ...baseParams, i: ITS_MTV_AM }),
  ]);

  if (!exportsData && !importsData) return { flows: [], ok: false };

  const rows: RawFlowRow[] = [
    ...(exportsData ? parseRows(exportsData, ITS_MTV_AX) : []),
    ...(importsData ? parseRows(importsData, ITS_MTV_AM) : []),
  ];

  const flows = buildFlowRecords(rows, reporter, partner || '000');

  return { flows, ok: true };
}

export async function getTradeFlows(
  _ctx: ServerContext,
  req: GetTradeFlowsRequest,
): Promise<GetTradeFlowsResponse> {
  try {
    // Input validation
    const reporter = isValidCode(req.reportingCountry) ? req.reportingCountry : '840';
    const partner = isValidCode(req.partnerCountry) ? req.partnerCountry : '000';
    const years = Math.max(1, Math.min(req.years > 0 ? req.years : 10, 30));

    const cacheKey = `trade:flows:v1:${reporter}:${partner}:${years}`;
    const result = await cachedFetchJson<GetTradeFlowsResponse>(
      cacheKey,
      REDIS_CACHE_TTL,
      async () => {
        const { flows, ok } = await fetchTradeFlows(reporter, partner, years);
        if (!ok) return null;
        return { flows, fetchedAt: new Date().toISOString(), upstreamUnavailable: false };
      },
    );

    return result ?? { flows: [], fetchedAt: new Date().toISOString(), upstreamUnavailable: true };
  } catch {
    return {
      flows: [],
      fetchedAt: new Date().toISOString(),
      upstreamUnavailable: true,
    };
  }
}
