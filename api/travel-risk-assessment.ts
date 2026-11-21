/**
 * In-app export of the travel risk assessment (#10451, phase 2).
 *
 * POST /api/travel-risk-assessment
 * Body: { countries: [{ country_code, cities?, arrive?, depart? }], date_from?, date_to?, task_label?, format: 'markdown' | 'html' }
 * Auth: a signed-in browser session (Bearer). The account must hold the
 * `travelRiskAssessment` plan feature: Pro Business, API Business, Enterprise.
 *
 * Returns the draft as a file attachment, text/markdown or text/html. The
 * logic is in server/_shared/travel-risk-export.ts so it can be tested without
 * the edge runtime. Nothing is stored.
 */

export const config = { runtime: 'edge', regions: ['iad1', 'lhr1', 'fra1', 'sfo1'] };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from './_cors.js';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from './_sentry-edge.js';
import { validateBearerToken } from '../server/auth-session';
import { getEntitlements, isEntitlementBackendConfigured } from '../server/_shared/entitlement-check';
import { checkRateLimit, checkScopedRateLimit, scopedTooManyRequestsResponse } from '../server/_shared/rate-limit';
import { createTravelRiskExportHandler } from '../server/_shared/travel-risk-export';
import { createTravelRiskTool } from './mcp/registry/travel-risk-tool';
import type { TravelRiskResult } from './mcp/registry/_travel-risk-document';

const RATE_SCOPE = '/api/travel-risk-assessment';
const RATE_LIMIT = 20;
const RATE_WINDOW = '60 s';

const tool = createTravelRiskTool();

export default createTravelRiskExportHandler({
  corsHeaders: (request) => getCorsHeaders(request, 'POST, OPTIONS'),
  // The role is not used, so skip the plan lookup it would trigger.
  validateBearer: (token) => validateBearerToken(token, { resolvePlan: false }),
  getEntitlements,
  backendConfigured: isEntitlementBackendConfigured,
  rateLimit: async (request, cors, userId) => {
    const global = await checkRateLimit(request, cors, { principalUserId: userId });
    if (global) return global;
    // A build reads about 20 cached sources, so it gets its own, much tighter,
    // per-account budget than the 600 a minute every route shares.
    // Redis-degraded scoped limits intentionally stay availability-first here:
    // the route is plan-gated and spends no LLM budget, and the sources it reads
    // live in the same Redis, so an outage that degrades this limiter already
    // makes the build answer 503.
    const scoped = await checkScopedRateLimit(RATE_SCOPE, RATE_LIMIT, RATE_WINDOW, userId);
    return scoped.allowed ? null : scopedTooManyRequestsResponse(scoped, RATE_WINDOW, cors);
  },
  build: async (params) => {
    if (!tool._execute) throw new Error('travel risk tool has no executor');
    return await tool._execute(params, '', { kind: 'free' }, undefined as never) as TravelRiskResult;
  },
  now: () => Date.now(),
  captureError: (error, context) => {
    captureSilentError(error, {
      tags: { route: 'api/travel-risk-assessment', step: context.step },
      fingerprint: ['api/travel-risk-assessment', context.step, error instanceof Error ? error.name : 'Error'],
    });
  },
});
