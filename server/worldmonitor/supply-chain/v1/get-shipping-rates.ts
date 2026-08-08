import type {
  ServerContext,
  GetShippingRatesRequest,
  GetShippingRatesResponse,
  ShippingIndex,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'supply_chain:shipping:v2';

// The seeder writes the four decision-grade period-change fields as an explicit
// JSON `null` whenever the exchange published no comparable prior (#6066), and
// this handler returns the cached blob verbatim. `ShippingIndex` declares those
// fields `optional`, which in this repo means "absent from the JSON", not
// "null" — the generated client types them `number | undefined` and the OpenAPI
// schema types them as a bare `number` with no `nullable`. Collapse null to
// undefined so the wire payload matches the declared contract (#6078), mirroring
// get-market-breadth-history.ts's nullToUndefined seam for the same proto shape.
function nullToUndefined<T>(value: T | null | undefined): T | undefined {
  return value == null ? undefined : value;
}

function normalizeIndex(index: ShippingIndex): ShippingIndex {
  const priorPeriodValue = nullToUndefined(index.priorPeriodValue);
  return {
    ...index,
    periodChangePct: nullToUndefined(index.periodChangePct),
    periodChangeBasis: nullToUndefined(index.periodChangeBasis),
    priorPeriodValue,
    // prior_period_date is declared as the date OF prior_period_value, so it
    // must not outlive it. The seeder accepts the publisher's `lastDate`
    // independently of whether `lastContent` was a usable number, so a dated
    // envelope with an unusable prior level yields a date describing a level
    // that was never published. #6077 tightens this seeder-side; enforcing it
    // here keeps the served response self-consistent either way.
    priorPeriodDate: priorPeriodValue === undefined ? undefined : nullToUndefined(index.priorPeriodDate),
  };
}

function unavailable(): GetShippingRatesResponse {
  return { indices: [], fetchedAt: new Date().toISOString(), upstreamUnavailable: true };
}

export async function getShippingRates(
  _ctx: ServerContext,
  _req: GetShippingRatesRequest,
): Promise<GetShippingRatesResponse> {
  try {
    const result = await getCachedJson(REDIS_CACHE_KEY, true) as GetShippingRatesResponse | null;
    if (!result) return unavailable();
    return { ...result, indices: (result.indices ?? []).map(normalizeIndex) };
  } catch {
    return unavailable();
  }
}
