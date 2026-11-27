// POST: a signed-in /pro visitor (Clerk bearer) previews or applies the
// in-place Pro Monthly → Pro Yearly switch. Body: { confirm: boolean,
// discounted?: boolean, acceptedChargeAmount?: number,
// acceptedChargeCurrency?: string, listPrice?: boolean }.
// - A confirm echoes the quote's `discounted` flag, so the change applies the
//   price the user saw or fails closed (PROMO_ENDED, PROMO_CODE_REJECTED).
// - A confirm may name the charge it accepted, in minor units; a higher one is
//   refused with CHARGE_CHANGED.
// - listPrice asks for a quote without the running offer's code.
// The route and its relay (/relay/pro-annual-switch) are separate from the Pro
// Business upgrade, so a deployment that predates the switch answers 404 and
// nothing is charged. The dashboard calls the Convex action switchToProAnnual.
export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { checkRateLimit } from './_rate-limit.js';
import { createPlanChangeHandler, PLAN_CHANGE_RATE_LIMIT } from './_plan-change-relay';

export default createPlanChangeHandler({
  pathname: '/api/pro-annual-switch',
  relayPath: '/relay/pro-annual-switch',
  routeName: 'pro-annual-switch',
  userAgent: 'worldmonitor-pro-annual-switch-edge/1.0',
  parseBody: (body) => {
    const { confirm, discounted, acceptedChargeAmount: amount, acceptedChargeCurrency: currency, listPrice } = body;
    if (typeof confirm !== 'boolean') return null;
    if (discounted !== undefined && typeof discounted !== 'boolean') return null;
    // A confirm must name the quote it accepts.
    if (confirm && discounted === undefined) return null;
    const namesCharge = amount !== undefined || currency !== undefined;
    if (namesCharge && (
      typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0 ||
      typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)
    )) {
      return null;
    }
    if (listPrice !== undefined && typeof listPrice !== 'boolean') return null;
    return {
      confirm,
      ...(discounted !== undefined ? { discounted } : {}),
      ...(namesCharge ? { acceptedChargeAmount: amount, acceptedChargeCurrency: currency } : {}),
      ...(listPrice !== undefined ? { listPrice } : {}),
    };
  },
  rateLimit: (req, cors, userId, ctx) => checkRateLimit(req, cors, {
    ...PLAN_CHANGE_RATE_LIMIT, identifier: userId, ctx,
  }),
});
