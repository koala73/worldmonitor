import type {
  ServerContext,
  GetCountryProductsRequest,
  GetCountryProductsResponse,
  CountryProduct,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

import { isCallerPremium } from '../../../_shared/premium-check';
import { getCachedJson } from '../../../_shared/redis';

interface BilateralHs4Payload {
  iso2: string;
  products?: CountryProduct[];
  fetchedAt?: string;
}

export async function getCountryProducts(
  ctx: ServerContext,
  req: GetCountryProductsRequest,
): Promise<GetCountryProductsResponse> {
  const iso2 = (req.iso2 ?? '').trim().toUpperCase();

  // Input-shape errors return 400 — restoring the legacy /api/supply-chain/v1/
  // country-products contract which predated the sebuf migration. Empty-payload-200
  // is reserved for the PRO-gate deny path (intentional contract shift), not for
  // caller bugs (malformed/missing fields). Distinguishing the two matters for
  // logging, external API consumers, and silent-failure detection.
  if (!/^[A-Z]{2}$/.test(iso2)) {
    throw new ValidationError([{ field: 'iso2', description: 'iso2 must be a 2-letter uppercase ISO country code' }]);
  }

  const isPro = await isCallerPremium(ctx.request);
  const empty: GetCountryProductsResponse = { iso2, products: [], fetchedAt: '' };
  if (!isPro) return empty;

  // Seeder writes via raw key (no env-prefix) — match it on read.
  const key = `comtrade:bilateral-hs4:${iso2}:v1`;
  const payload = await getCachedJson(key, true).catch(() => null) as BilateralHs4Payload | null;
  if (!payload) return empty;

  return {
    iso2,
    products: Array.isArray(payload.products) ? payload.products : [],
    fetchedAt: payload.fetchedAt ?? '',
  };
}
