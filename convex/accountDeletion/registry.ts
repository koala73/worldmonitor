/**
 * Account-deletion registry (plan U1 / KTD2).
 *
 * Every user-scoped Convex table must appear here as delete, anonymize,
 * retain, delegate, or skip. Batch steppers in `batches.ts` implement the
 * action; adding a table means updating both files.
 */

export type DeletionAction =
  | "delete"
  | "anonymize"
  | "retain"
  | "delegate"
  | "skip";

export type RegistryEntry = {
  target: string;
  action: DeletionAction;
  notes: string;
};

export const ACCOUNT_DELETION_REGISTRY: readonly RegistryEntry[] = [
  { target: "users", action: "delete", notes: "Core profile" },
  { target: "userPreferences", action: "delete", notes: "Cloud prefs" },
  {
    target: "userPreferenceWriteRateLimits",
    action: "delete",
    notes: "Prefs write counters",
  },
  { target: "notificationChannels", action: "delete", notes: "Contact endpoints" },
  { target: "alertRules", action: "delete", notes: "Alert config" },
  { target: "telegramPairingTokens", action: "delete", notes: "Telegram pairing" },
  {
    target: "followedCountries",
    action: "delete",
    notes: "Watchlist rows; decrement country aggregates when locks are seeded",
  },
  {
    target: "followedCountriesUserMeta",
    action: "delete",
    notes: "Per-user follow meta",
  },
  {
    target: "followedCountriesCounts",
    action: "retain",
    notes: "Country aggregates stay; this user's follows decrement them",
  },
  {
    target: "followedCountriesShards",
    action: "retain",
    notes: "Pre-seeded OCC shards are global",
  },
  {
    target: "followedCountriesCountryLocks",
    action: "retain",
    notes: "Pre-seeded country locks are global",
  },
  { target: "userApiKeys", action: "delete", notes: "Revoke by deleting rows" },
  { target: "embedKeys", action: "delete", notes: "Partner embed keys" },
  { target: "mcpProTokens", action: "delete", notes: "Pro MCP grants" },
  {
    target: "businessProGrants",
    action: "delete",
    notes: "Owner via subscriptions; invitee via userId/email",
  },
  { target: "userReferralCodes", action: "delete", notes: "Referral codes" },
  {
    target: "userReferralCredits",
    action: "delete",
    notes: "Referrer-owned credits (PII in referee email)",
  },
  { target: "entitlements", action: "delete", notes: "Access, not invoices" },
  { target: "apiUsageRollups", action: "delete", notes: "Usage windows" },
  { target: "apiPlanLimitNotices", action: "delete", notes: "Plan-limit notices" },
  { target: "checkoutAdmissions", action: "delete", notes: "Checkout admission counters" },
  {
    target: "proActivationPresentations",
    action: "delete",
    notes: "Activation session records; not invoices",
  },
  {
    target: "dunningEmails",
    action: "anonymize",
    notes: "Keep step timestamps; strip recipient email",
  },
  {
    target: "customers",
    action: "anonymize",
    notes: "Keep dodoCustomerId; strip email; tombstone userId",
  },
  {
    target: "subscriptions",
    action: "anonymize",
    notes: "Retain periods and amounts; strip PII in rawPayload; tombstone userId",
  },
  {
    target: "paymentEvents",
    action: "anonymize",
    notes: "Retain payment evidence; tombstone userId; strip email from rawPayload",
  },
  {
    target: "deletedSubscriptionCustomers",
    action: "anonymize",
    notes: "Portal-exclusivity rows; tombstone userId",
  },
  {
    target: "registrations",
    action: "delete",
    notes: "Waitlist rows matching verified account email after Clerk subject is confirmed",
  },
  {
    target: "contactMessages",
    action: "delete",
    notes: "Contact form rows matching verified account email",
  },
  {
    target: "emailSuppressions",
    action: "retain",
    notes: "Bounce/complaint (and other) suppressions stay so we do not re-mail",
  },
  {
    target: "companyMonitoringAccounts",
    action: "delegate",
    notes: "markOwnerDeleted / advanceAccountPurge",
  },
  {
    target: "checkoutRateLimitEvents",
    action: "skip",
    notes: "No userId index; TTL/self-prune only",
  },
  {
    target: "checkoutTimeoutEvents",
    action: "skip",
    notes: "No userId index",
  },
  {
    target: "paymentReconciliationAttempts",
    action: "skip",
    notes: "No userId index",
  },
  {
    target: "wavePickedContacts",
    action: "skip",
    notes: "No userId index; broadcast pick rows are not the account record",
  },
] as const;

export const ERASE_WRITE_BUDGET = 64;

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function tombstoneUserId(userIdHash: string): string {
  return `deleted:${userIdHash}`;
}

export function normalizeVerifiedEmail(
  email: string | undefined | null,
): string | undefined {
  if (typeof email !== "string") return undefined;
  const normalized = email.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

const CUSTOMER_PII_KEYS = new Set(["email", "name"]);

/**
 * Strip person-identifying fields from Dodo-shaped billing payloads while
 * keeping amounts, ids, and periods.
 */
export function redactBillingPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactBillingPayload(entry));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(source)) {
    const lower = key.toLowerCase();
    if (lower === "email" || lower === "normalizedemail" || lower === "normalized_email") {
      continue;
    }
    if (lower === "customer" && nested && typeof nested === "object" && !Array.isArray(nested)) {
      const customer: Record<string, unknown> = {};
      for (const [customerKey, customerValue] of Object.entries(
        nested as Record<string, unknown>,
      )) {
        if (CUSTOMER_PII_KEYS.has(customerKey.toLowerCase())) continue;
        customer[customerKey] = redactBillingPayload(customerValue);
      }
      out[key] = customer;
      continue;
    }
    out[key] = redactBillingPayload(nested);
  }
  return out;
}
