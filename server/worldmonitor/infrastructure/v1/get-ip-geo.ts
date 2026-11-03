import type {
  InfrastructureServiceHandler,
  ServerContext,
  GetIpGeoRequest,
  GetIpGeoResponse,
} from '../../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';
import { hasCloudflareTransitProof } from '../../../_shared/client-ip';

const ISO_COUNTRY_RE = /^[A-Z]{2}$/;

/**
 * GetIpGeo returns geographic information based on the request headers (Cloudflare/Vercel).
 *
 * `cf-ipcountry` is caller-controlled unless the request provably transited
 * Cloudflare (same gate as deriveCountry in server/_shared/usage.ts), so it is
 * only honored with transit proof. Vercel's `x-vercel-ip-*` connection headers
 * are platform-set on Vercel and are the fallback. Values are validated to the
 * ISO 3166-1 alpha-2 shape (`T1` and anything else non-conforming map to `XX`)
 * and the city is URL-decoded like deriveIpCity.
 */
export const getIpGeo: InfrastructureServiceHandler['getIpGeo'] = async (
  ctx: ServerContext,
  _req: GetIpGeoRequest,
): Promise<GetIpGeoResponse> => {
  const headers = ctx.headers;
  const rawCf = hasCloudflareTransitProof(ctx.request)
    ? headers['cf-ipcountry']
    : undefined;
  const rawVercel = headers['x-vercel-ip-country'];

  const validCf = rawCf && rawCf !== 'T1' && ISO_COUNTRY_RE.test(rawCf) ? rawCf : null;
  const validVercel = rawVercel && rawVercel !== 'T1' && ISO_COUNTRY_RE.test(rawVercel) ? rawVercel : null;
  const country = validCf || validVercel || 'XX';

  let city = headers['x-vercel-ip-city'] || '';
  if (city.length > 128) city = city.slice(0, 128);
  if (city) {
    try {
      city = decodeURIComponent(city);
    } catch {
      // Keep the raw value when it is not valid percent-encoding.
    }
  }
  let region = headers['x-vercel-ip-country-region'] || '';
  if (region.length > 64) region = region.slice(0, 64);

  return {
    country,
    region,
    city,
  };
};
