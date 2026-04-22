/**
 * Whitelist map from server-emitted `planKey` values to user-facing
 * display names. Separate pure module so unit tests can lock the
 * rendering contract without a browser env.
 *
 * The duplicate-subscription 409 server payload includes a
 * `subscription.planKey` string. We do NOT render that value raw or
 * even `subscription.displayName` because both originate server-side
 * and could drift / include text we don't want to expose. The
 * whitelist ensures the dialog only shows copy we've shipped in this
 * client build; unknown planKeys fall back to a generic "Pro".
 */

const PLAN_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  pro_monthly: 'Pro Monthly',
  pro_annual: 'Pro Annual',
  api_starter: 'API Starter',
  api_business: 'API Business',
};

/**
 * Map a server-emitted planKey to a safe, whitelisted display name.
 * Falls back to "Pro" for any unknown or missing key — the user
 * still gets a coherent sentence even if the server rolls out a new
 * plan before the client ships.
 */
export function resolvePlanDisplayName(planKey: unknown): string {
  if (typeof planKey !== 'string' || planKey.length === 0) return 'Pro';
  return PLAN_DISPLAY_NAMES[planKey] ?? 'Pro';
}

/** Exposed only for tests — do not use in runtime code. */
export const KNOWN_PLAN_KEYS = Object.keys(PLAN_DISPLAY_NAMES);
