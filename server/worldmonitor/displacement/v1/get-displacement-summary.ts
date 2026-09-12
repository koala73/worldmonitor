import type {
  ServerContext,
  GetDisplacementSummaryRequest,
  GetDisplacementSummaryResponse,
} from '../../../../src/generated/server/worldmonitor/displacement/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/displacement/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

// Railway owns fetching, aggregation and publication; RPC callers only select seed data.
export async function getDisplacementSummary(
  _ctx: ServerContext,
  req: GetDisplacementSummaryRequest,
): Promise<GetDisplacementSummaryResponse> {
  const currentYear = new Date().getFullYear();
  if (!Number.isInteger(req.year) || (req.year !== 0 && (req.year < 1951 || req.year > currentYear))) {
    throw new ValidationError([{ field: 'year', description: `year must be 0 or between 1951 and ${currentYear}` }]);
  }
  const emptyResponse: GetDisplacementSummaryResponse = {
    summary: {
      year: req.year || currentYear,
      globalTotals: { refugees: 0, asylumSeekers: 0, idps: 0, stateless: 0, total: 0 },
      countries: [],
      topFlows: [],
    },
    fetchedAt: 0,
    dataAvailable: false,
  };

  try {
    // The current-year key can contain prior-year data when UNHCR has not published yet.
    const [seedData, seedMeta] = await Promise.all([
      getCachedJson(`displacement:summary:v1:${currentYear}`, true) as Promise<GetDisplacementSummaryResponse | null>,
      getCachedJson('seed-meta:displacement:summary', true) as Promise<{ fetchedAt?: number } | null>,
    ]);
    if (!seedData?.summary || !Number.isFinite(seedMeta?.fetchedAt)
      || (req.year !== 0 && seedData.summary.year !== req.year)) return emptyResponse;

    const summary = { ...seedData.summary };
    if (req.countryLimit > 0) summary.countries = summary.countries.slice(0, req.countryLimit);
    const flowLimit = req.flowLimit > 0 ? req.flowLimit : 50;
    summary.topFlows = summary.topFlows.slice(0, flowLimit);
    return { summary, fetchedAt: seedMeta?.fetchedAt ?? 0, dataAvailable: true };
  } catch {
    return emptyResponse;
  }
}
