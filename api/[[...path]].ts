/**
 * Vercel catch-all edge function — mounts all sebuf-generated routes.
 *
 * Every POST to /api/{domain}/v1/{rpc} is routed through this handler.
 * CORS headers are applied to every response (200, 204, 403, 404).
 */

export const config = { runtime: 'edge' };

import { createRouter } from './server/router';
import { getCorsHeaders, isDisallowedOrigin } from './server/cors';
import { mapErrorToResponse } from './server/error-mapper';
import { createSeismologyServiceRoutes } from '../src/generated/server/worldmonitor/seismology/v1/service_server';
import { seismologyHandler } from './server/worldmonitor/seismology/v1/handler';
import { createWildfireServiceRoutes } from '../src/generated/server/worldmonitor/wildfire/v1/service_server';
import { wildfireHandler } from './server/worldmonitor/wildfire/v1/handler';
import { createClimateServiceRoutes } from '../src/generated/server/worldmonitor/climate/v1/service_server';
import { climateHandler } from './server/worldmonitor/climate/v1/handler';
import { createPredictionServiceRoutes } from '../src/generated/server/worldmonitor/prediction/v1/service_server';
import { predictionHandler } from './server/worldmonitor/prediction/v1/handler';
import { createDisplacementServiceRoutes } from '../src/generated/server/worldmonitor/displacement/v1/service_server';
import { displacementHandler } from './server/worldmonitor/displacement/v1/handler';
import { createAviationServiceRoutes } from '../src/generated/server/worldmonitor/aviation/v1/service_server';
import { aviationHandler } from './server/worldmonitor/aviation/v1/handler';
import { createResearchServiceRoutes } from '../src/generated/server/worldmonitor/research/v1/service_server';
import { researchHandler } from './server/worldmonitor/research/v1/handler';
import { createUnrestServiceRoutes } from '../src/generated/server/worldmonitor/unrest/v1/service_server';
import { unrestHandler } from './server/worldmonitor/unrest/v1/handler';
import { createConflictServiceRoutes } from '../src/generated/server/worldmonitor/conflict/v1/service_server';
import { conflictHandler } from './server/worldmonitor/conflict/v1/handler';

import type { ServerOptions } from '../src/generated/server/worldmonitor/seismology/v1/service_server';

const serverOptions: ServerOptions = { onError: mapErrorToResponse };

const allRoutes = [
  ...createSeismologyServiceRoutes(seismologyHandler, serverOptions),
  ...createWildfireServiceRoutes(wildfireHandler, serverOptions),
  ...createClimateServiceRoutes(climateHandler, serverOptions),
  ...createPredictionServiceRoutes(predictionHandler, serverOptions),
  ...createDisplacementServiceRoutes(displacementHandler, serverOptions),
  ...createAviationServiceRoutes(aviationHandler, serverOptions),
  ...createResearchServiceRoutes(researchHandler, serverOptions),
  ...createUnrestServiceRoutes(unrestHandler, serverOptions),
  ...createConflictServiceRoutes(conflictHandler, serverOptions),
];

const router = createRouter(allRoutes);

export default async function handler(request: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(request);

  // OPTIONS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Origin check
  if (isDisallowedOrigin(request)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  // Route matching
  const matchedHandler = router.match(request);
  if (!matchedHandler) {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  // Execute handler
  const response = await matchedHandler(request);

  // Merge CORS headers into response
  const mergedHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    mergedHeaders.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: mergedHeaders,
  });
}
