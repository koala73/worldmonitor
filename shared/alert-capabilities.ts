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
 * time. `resolveAlertCapabilities` falls back BY TIER when a features object
 * predates the fields: a paid row keeps full access (never punish a paying
 * customer for a stale cache), a free row fails closed to the free ladder.
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

// The free ladder (#4273): get pinged when something CRITICAL happens in up
// to 3 countries you follow, over the two zero-cost channels. 3 mirrors
// FREE_TIER_FOLLOW_LIMIT (convex/followedCountries.ts); the paid ceiling
// mirrors COUNTRIES_MAX (convex/alertRules.ts).
export const FREE_ALERT_MAX_COUNTRIES = 3;
export const FREE_ALERT_CHANNELS = ["web_push", "email"] as const;
export const FREE_ALERT_SENSITIVITIES = ["critical"] as const;
// Daily digests for free accounts land with the digest-cron follow-up
// (scripts/seed-digest-notifications.mjs still delivers to tier >= 1 only);
// advertising a mode that cron drops would be a silent lie, so the free
// ladder opens with realtime only. Widen to ["realtime", "daily"] in the
// same change that makes the cron free-aware.
export const FREE_ALERT_DIGEST_MODES = ["realtime"] as const;

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
  /**
   * Worldwide (unscoped) alert rules are a paid capability: a free rule must
   * name 1..maxCountries countries, or `eventMatchesCountryScope` treats the
   * empty scope as every country and the ladder's country limit means
   * nothing (Greptile P1 on #10303). Keyed off tier until a plan needs its
   * own value.
   */
  requireCountryScope: boolean;
}

export function resolveAlertCapabilities(
  features: AlertCapabilityFeatures | null | undefined,
): AlertCapabilities {
  const paid = (features?.tier ?? 0) >= 1;
  return {
    maxCountries:
      features?.alertMaxCountries ??
      (paid ? PAID_ALERT_MAX_COUNTRIES : FREE_ALERT_MAX_COUNTRIES),
    channels: new Set(
      features?.alertChannels ?? (paid ? ALL_ALERT_CHANNELS : FREE_ALERT_CHANNELS),
    ),
    sensitivities: new Set(
      features?.alertSensitivities ??
        (paid ? ALL_ALERT_SENSITIVITIES : FREE_ALERT_SENSITIVITIES),
    ),
    digestModes: new Set(
      features?.alertDigestModes ??
        (paid ? ALL_ALERT_DIGEST_MODES : FREE_ALERT_DIGEST_MODES),
    ),
    aiDigestAccess: features?.aiDigestAccess ?? paid,
    requireCountryScope: !paid,
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
