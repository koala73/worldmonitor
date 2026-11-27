// POST: a signed-in /pro visitor (Clerk bearer) previews or applies the
// in-place Pro → Pro Business upgrade. Body: { confirm: boolean }.
// confirm=false returns the prorated charge; confirm=true moves the existing
// Dodo subscription to Pro Business. The Pro Monthly → Pro Yearly switch has
// its own route (api/pro-annual-switch.ts); a request naming any other `kind`
// is refused here before the limiter and the relay, never run as this upgrade.
// The dashboard calls the Convex action directly; this edge route exists
// because /pro is a separate build without a Convex client.
export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { checkRateLimit } from './_rate-limit.js';
import { createPlanChangeHandler, PLAN_CHANGE_RATE_LIMIT } from './_plan-change-relay';

export default createPlanChangeHandler({
  pathname: '/api/pro-business-upgrade',
  relayPath: '/relay/pro-business-upgrade',
  routeName: 'pro-business-upgrade',
  userAgent: 'worldmonitor-pro-business-upgrade-edge/1.0',
  parseBody: (body) => {
    if (typeof body.confirm !== 'boolean') return null;
    if (body.kind !== undefined && body.kind !== 'pro_business') return null;
    // Exactly the body this route forwarded before the switch existed.
    return { confirm: body.confirm };
  },
  rateLimit: (req, cors, userId, ctx) => checkRateLimit(req, cors, {
    ...PLAN_CHANGE_RATE_LIMIT, identifier: userId, ctx,
  }),
});
