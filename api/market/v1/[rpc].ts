// Regions pinned (#4944 U7): analyze-stock reaches callLlm — OpenRouter/LLM
// calls from restricted-region edge nodes fail with geo-keyed 403s. Mirrors
// api/news/v1/[rpc].ts and api/intelligence/v1/[rpc].ts.
export const config = { runtime: 'edge', regions: ['iad1', 'lhr1', 'fra1', 'sfo1'] };

import { createDomainGateway, serverOptions } from '../../../server/gateway';
import { createMarketServiceRoutes } from '../../../src/generated/server/worldmonitor/market/v1/service_server';
import { marketHandler } from '../../../server/worldmonitor/market/v1/handler';

export default createDomainGateway(
  createMarketServiceRoutes(marketHandler, serverOptions),
);
