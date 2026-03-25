import type {
  InfrastructureServiceHandler,
  ServerContext,
  GetIpGeoRequest,
  GetIpGeoResponse,
} from '../../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';

/**
 * GetIpGeo returns geographic information based on the request headers (Cloudflare/Vercel).
 */
export const getIpGeo: InfrastructureServiceHandler['getIpGeo'] = async (
  ctx: ServerContext,
  _req: GetIpGeoRequest,
): Promise<GetIpGeoResponse> => {
  const headers = ctx.headers;
  const cfCountry = headers['cf-ipcountry'];
  const vercelCountry = headers['x-vercel-ip-country'];
  
  const country = (cfCountry && cfCountry !== 'T1' ? cfCountry : null) || vercelCountry || 'XX';
  
  return {
    country,
    region: headers['x-vercel-ip-region'] || '',
    city: headers['x-vercel-ip-city'] || '',
  };
};
