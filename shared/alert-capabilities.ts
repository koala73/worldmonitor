/**
 * Alert-capability model for the free-tier alert ladder (#4273).
 *
 * Pure data + predicates shared by the three write-path gates (the edge
 * handler `api/notification-channels.ts`, and the Convex mutations in
 * `convex/alertRules.ts` / `convex/notificationChannels.ts`) and by the
 * product catalog, so the ladder's numbers have one home. The delivery-time
 * clamp in `scripts/notification-relay.cjs` mirrors the FREE_* values in CJS
 * (it cannot import TS); keep the two in step.
 *
 * Capability semantics: these fields are plan STRUCTURE, like the desktop-key
 * limits — `mergeEntitlementFeatures` takes them from the catalog, never from
 * a stored row, so a pricing change applies to existing subscribers at read
 * time. `resolveAlertCapabilities` falls back to the full free-account feature
 * set when a features object predates these fields.
 */

export const ALERT_UPGRADE_URL = "https://worldmonitor.app/pro";

export const ALL_ALERT_CHANNELS = [
  "telegram",
  "slack",
  "email",
  "discord",
  "teams",
  "webhook",
  "web_push",
] as const;

export const ALL_ALERT_SENSITIVITIES = ["all", "high", "critical"] as const;

export const ALL_ALERT_DIGEST_MODES = [
  "realtime",
  "daily",
  "twice_daily",
  "weekly",
] as const;

// Subscription-gated alert capabilities are included in the free account.
// Keep these fallbacks aligned with the full capability set so legacy rows
// without explicit plan fields receive the same access as newly written rows.
export const FREE_ALERT_MAX_COUNTRIES = 50;
export const FREE_ALERT_CHANNELS = ALL_ALERT_CHANNELS;
export const FREE_ALERT_SENSITIVITIES = ALL_ALERT_SENSITIVITIES;
export const FREE_ALERT_DIGEST_MODES = ALL_ALERT_DIGEST_MODES;

export const PAID_ALERT_MAX_COUNTRIES = 50;

export interface AlertCapabilityFeatures {
  tier?: number;
  alertMaxCountries?: number;
  alertChannels?: readonly string[];
  alertSensitivities?: readonly string[];
  alertDigestModes?: readonly string[];
  aiDigestAccess?: boolean;
}

export interface AlertCapabilities {
  maxCountries: number;
  channels: ReadonlySet<string>;
  sensitivities: ReadonlySet<string>;
  digestModes: ReadonlySet<string>;
  aiDigestAccess: boolean;
  /** Whether this plan requires alert rules to be limited to selected countries. */
  requireCountryScope: boolean;
}

export function resolveAlertCapabilities(
  features: AlertCapabilityFeatures | null | undefined,
): AlertCapabilities {
  return {
    maxCountries: features?.alertMaxCountries ?? FREE_ALERT_MAX_COUNTRIES,
    channels: new Set(features?.alertChannels ?? FREE_ALERT_CHANNELS),
    sensitivities: new Set(features?.alertSensitivities ?? FREE_ALERT_SENSITIVITIES),
    digestModes: new Set(features?.alertDigestModes ?? FREE_ALERT_DIGEST_MODES),
    aiDigestAccess: features?.aiDigestAccess ?? true,
    requireCountryScope: false,
  };
}

export type AlertCapabilityViolationCode =
  | "ALERT_COUNTRIES_UPGRADE_REQUIRED"
  | "ALERT_CHANNEL_UPGRADE_REQUIRED"
  | "ALERT_SENSITIVITY_UPGRADE_REQUIRED"
  | "ALERT_DIGEST_MODE_UPGRADE_REQUIRED"
  | "ALERT_COUNTRY_SCOPE_REQUIRED"
  | "AI_DIGEST_UPGRADE_REQUIRED";

export const ALERT_CAPABILITY_VIOLATION_CODES: readonly AlertCapabilityViolationCode[] = [
  "ALERT_COUNTRIES_UPGRADE_REQUIRED",
  "ALERT_CHANNEL_UPGRADE_REQUIRED",
  "ALERT_SENSITIVITY_UPGRADE_REQUIRED",
  "ALERT_DIGEST_MODE_UPGRADE_REQUIRED",
  "ALERT_COUNTRY_SCOPE_REQUIRED",
  "AI_DIGEST_UPGRADE_REQUIRED",
];

export interface AlertCapabilityViolation {
  code: AlertCapabilityViolationCode;
  message: string;
  upgradeUrl: string;
  /** The plan's limit, for ALERT_COUNTRIES_UPGRADE_REQUIRED. */
  limit?: number;
  /** The denied channel / sensitivity / digest mode, where one applies. */
  value?: string;
}

/**
 * The EFFECTIVE post-write state of one alert rule: the incoming field where
 * the caller sent one, otherwise the stored row's value. Each mutation passes
 * only the fields it writes, so editing quiet hours on a legacy
 * wider-than-plan row does not demand repairing the whole row first.
 */
export interface AlertRuleCapabilityState {
  countriesCount?: number;
  channels?: readonly string[];
  sensitivity?: string;
  digestMode?: string;
  aiDigestEnabled?: boolean;
  /**
   * The rule's EFFECTIVE enabled flag and country count after the write,
   * stored row included — unlike the only-what-you-send fields above, the
   * worldwide-scope check must see the whole rule, or omitting `countries`
   * bypasses it. A disable (`enabled: false`) is always allowed.
   */
  enabled?: boolean;
  effectiveCountriesCount?: number;
}

/**
 * First capability the state exceeds, or null when the plan covers it.
 * Checked most-specific first (channel, sensitivity, digest mode) so the
 * upsell can name the exact rung; countries and the AI digest close the list.
 */
export function firstAlertCapabilityViolation(
  state: AlertRuleCapabilityState,
  caps: AlertCapabilities,
): AlertCapabilityViolation | null {
  for (const channel of state.channels ?? []) {
    if (!caps.channels.has(channel)) {
      return {
        code: "ALERT_CHANNEL_UPGRADE_REQUIRED",
        message: `The ${channel} channel is available on the Pro plan.`,
        upgradeUrl: ALERT_UPGRADE_URL,
        value: channel,
      };
    }
  }
  if (state.sensitivity !== undefined && !caps.sensitivities.has(state.sensitivity)) {
    return {
      code: "ALERT_SENSITIVITY_UPGRADE_REQUIRED",
      message: `The "${state.sensitivity}" sensitivity is available on the Pro plan; your plan alerts on critical events.`,
      upgradeUrl: ALERT_UPGRADE_URL,
      value: state.sensitivity,
    };
  }
  if (state.digestMode !== undefined && !caps.digestModes.has(state.digestMode)) {
    return {
      code: "ALERT_DIGEST_MODE_UPGRADE_REQUIRED",
      message: `The "${state.digestMode}" delivery mode is available on the Pro plan.`,
      upgradeUrl: ALERT_UPGRADE_URL,
      value: state.digestMode,
    };
  }
  if (state.countriesCount !== undefined && state.countriesCount > caps.maxCountries) {
    return {
      code: "ALERT_COUNTRIES_UPGRADE_REQUIRED",
      message: `Your plan follows up to ${caps.maxCountries} countries for alerts; Pro follows up to ${PAID_ALERT_MAX_COUNTRIES}.`,
      upgradeUrl: ALERT_UPGRADE_URL,
      limit: caps.maxCountries,
    };
  }
  if (
    caps.requireCountryScope &&
    state.enabled !== false &&
    state.effectiveCountriesCount === 0
  ) {
    return {
      code: "ALERT_COUNTRY_SCOPE_REQUIRED",
      message: `Choose 1–${caps.maxCountries} countries to follow for alerts, or upgrade to Pro for worldwide alerts.`,
      upgradeUrl: ALERT_UPGRADE_URL,
      limit: caps.maxCountries,
    };
  }
  if (state.aiDigestEnabled === true && !caps.aiDigestAccess) {
    return {
      code: "AI_DIGEST_UPGRADE_REQUIRED",
      message: "AI-composed digests are available on the Pro plan.",
      upgradeUrl: ALERT_UPGRADE_URL,
    };
  }
  return null;
}
