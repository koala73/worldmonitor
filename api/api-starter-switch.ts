// POST: a signed-in /pro visitor (Clerk bearer) previews or applies the
// in-place individual Pro → API Starter switch. Body: { confirm: boolean,
// acceptedChargeAmount?: number, acceptedChargeCurrency?: string }.
// - confirm=false returns the prorated charge. /pro calls it first whenever a
//   signed-in visitor picks API Starter; a refusal other than a Pro holder's
//   sends the visitor on to the normal checkout.
// - A confirm names the charge it accepted, in minor units; a higher one is
//   refused with CHARGE_CHANGED.
// The route and its relay (/relay/api-starter-switch) are separate from the
// other plan changes, so a deployment that predates the switch answers 404
// and nothing is charged. The dashboard calls the Convex action
// switchToApiStarter.
export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { checkRateLimit } from './_rate-limit.js';
import { createPlanChangeHandler, PLAN_CHANGE_RATE_LIMIT } from './_plan-change-relay';

export default createPlanChangeHandler({
  pathname: '/api/api-starter-switch',
  relayPath: '/relay/api-starter-switch',
  routeName: 'api-starter-switch',
  userAgent: 'worldmonitor-api-starter-switch-edge/1.0',
  parseBody: (body) => {
    const { confirm, acceptedChargeAmount: amount, acceptedChargeCurrency: currency, kind } = body;
    if (typeof confirm !== 'boolean') return null;
    if (kind !== undefined && kind !== 'api_starter') return null;
    const namesCharge = amount !== undefined || currency !== undefined;
    if (confirm && !namesCharge) return null;
    if (namesCharge && (
      typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0 ||
      typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)
    )) {
      return null;
    }
    return {
      confirm,
      ...(namesCharge ? { acceptedChargeAmount: amount, acceptedChargeCurrency: currency } : {}),
    };
  },
  rateLimit: (req, cors, userId, ctx) => checkRateLimit(req, cors, {
    ...PLAN_CHANGE_RATE_LIMIT, identifier: userId, ctx,
  }),
});
