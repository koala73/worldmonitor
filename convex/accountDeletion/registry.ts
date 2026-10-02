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
  {
    target: "userApiKeys",
    action: "delete",
    notes: "Capture keyHash then delete; invalidate user-api-key Redis",
  },
  {
    target: "embedKeys",
    action: "delete",
    notes: "Capture keyHash then delete; invalidate embed-key Redis",
  },
  {
    target: "mcpProTokens",
    action: "delete",
    notes: "Capture token id then delete; write pro-mcp-token-neg:<tokenId>",
  },
  {
    target: "businessProGrants",
    action: "delete",
    notes: "Owner via subscriptions; invitee via userId/email",
  },
  { target: "userReferralCodes", action: "delete", notes: "Referral codes" },
  {
    target: "userReferralCredits",
    action: "delete",
    notes: "Delete referrer-owned credits; anonymize referee email on surviving credits",
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
    action: "retain",
    notes: "Keep step timestamps and recipient email as billing evidence",
  },
  {
    target: "customers",
    action: "anonymize",
    notes: "Keep dodoCustomerId and contact email; tombstone userId",
  },
  {
    target: "subscriptions",
    action: "anonymize",
    notes: "Retain periods, amounts, and Dodo customer contact data; strip internal identity bridge; tombstone userId",
  },
  {
    target: "paymentEvents",
    action: "anonymize",
    notes: "Retain payment evidence with Dodo customer contact data; strip internal identity bridge; tombstone userId",
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
    target: "webhookEvents",
    action: "retain",
    notes:
      "Raw provider archive, keyed by webhookId with no per-user index. Events "
      + "processed after the deletion row exists are redacted on insert "
      + "(webhookMutations.processWebhookEvent); rows written before the request "
      + "keep the identity bridge Dodo echoed back and are retained as delivered "
      + "(owner decision 2026-09-22). Sweeping them needs a denormalized "
      + "customer id plus an index; until then the tombstone means the billing "
      + "rows stop naming the account, not that no record can be re-joined.",
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
  {
    target: "redis:entitlements",
    action: "delete",
    notes: "entitlements:{env}:{userId}",
  },
  {
    target: "redis:user-api-key",
    action: "delete",
    notes: "user-api-key:<sha256> and bootstrap-user-api-key-invalid:<sha256>",
  },
  {
    target: "redis:briefs",
    action: "delete",
    notes: "brief:latest:{userId} and brief:{userId}:{slot} from that pointer",
  },
  {
    target: "clerk.users",
    action: "delete",
    notes: "Backend Users API; 404 is success",
  },
  {
    target: "dodo.subscriptions",
    action: "anonymize",
    notes: "Cancel covering subscriptions; keep merchant customer and invoices",
  },
  {
    target: "workos.users",
    action: "skip",
    notes: "Consumer identity is the Clerk subject; no separate WorkOS user row",
  },

  // --- Closed-world completions (2026-09-22) -------------------------------
  // The header above promised every table appears here, but 24 did not, so the
  // promise was unenforceable and a new user-scoped table could ship with no
  // erasure decision. `accountDeletion.test.ts` now walks convex/schema.ts
  // against this list; these entries are what make that gate pass honestly.
  {
    target: "accountDeletions",
    action: "retain",
    notes:
      "The deletion ledger itself. Keeps the plaintext userId indefinitely on "
      + "purpose: billingDeletionForUser resolves a deleted:<sha256> tombstone "
      + "back through by_userIdHash, and the write fence reads it to reject new "
      + "personal writes. Only verifiedEmail is cleared on complete.",
  },
  {
    target: "unattributedPaymentEvents",
    action: "retain",
    notes:
      "Operator repair queue for payments no account could be attributed to. "
      + "Holds customerEmail, customerName, the raw Dodo payload, and a "
      + "resolvedUserId once repaired, so it is user-scoped in substance — "
      + "retained under the same billing-evidence decision as webhookEvents, "
      + "not swept. Deleting it would destroy the evidence that someone paid "
      + "and holds no access.",
  },
  {
    target: "paymentWebhookFailures",
    action: "retain",
    notes: "Dead-letter projection: Dodo ids, error text, and dataKeys only; no payload",
  },
  {
    target: "paymentWebhookFailureSummary",
    action: "retain",
    notes: "Aggregate failure counters; carries no per-user field",
  },
  { target: "productPlans", action: "skip", notes: "Global product catalog" },
  { target: "counters", action: "skip", notes: "Global counters" },
  { target: "businessSeatLocks", action: "skip", notes: "Global OCC locks" },
  { target: "broadcastRampConfig", action: "skip", notes: "Global broadcast ramp settings" },
  { target: "broadcastEvents", action: "skip", notes: "Broadcast send log; not the account record" },
  { target: "waveRuns", action: "skip", notes: "Broadcast wave runs; not the account record" },
  { target: "intelHistory", action: "skip", notes: "Global intel corpus, not user-scoped" },
  { target: "intelHistoryRetractions", action: "skip", notes: "Global intel corpus" },
  { target: "intelHistoryAppendLocks", action: "skip", notes: "Global OCC locks" },
  // Company Monitoring children follow their account row, which is `delegate`
  // above. markOwnerDeleted / advanceAccountPurge owns their lifecycle; this
  // PR only refactored the entry point into applyOwnerDeletedFence and did not
  // change that cleanup's scope.
  { target: "companyMonitoringCompanies", action: "delegate", notes: "Via companyMonitoringAccounts purge" },
  { target: "companyMonitoringClaims", action: "delegate", notes: "Via companyMonitoringAccounts purge" },
  { target: "companyMonitoringEvidence", action: "delegate", notes: "Via companyMonitoringAccounts purge" },
  { target: "companyMonitoringCandidates", action: "delegate", notes: "Via companyMonitoringAccounts purge" },
  { target: "companyMonitoringAdmissionDecisions", action: "delegate", notes: "Via companyMonitoringAccounts purge" },
  { target: "companyMonitoringScanObligations", action: "delegate", notes: "Via companyMonitoringAccounts purge" },
  { target: "companyMonitoringScanReceiptLinks", action: "delegate", notes: "Via companyMonitoringAccounts purge" },
  { target: "companyMonitoringScanWorkItems", action: "delegate", notes: "Via companyMonitoringAccounts purge" },
  { target: "companyMonitoringXIdentities", action: "delegate", notes: "Via companyMonitoringAccounts purge" },
  { target: "companyMonitoringXEvidence", action: "delegate", notes: "Via companyMonitoringAccounts purge" },
  { target: "companyMonitoringXPostAliases", action: "delegate", notes: "Via companyMonitoringAccounts purge" },
] as const;

export const ERASE_WRITE_BUDGET = 64;

/**
 * How stale a `pending` deletion must be before it is treated as stalled and
 * its worker re-armed — by an entry point in `erase.ts` or by the sweeper cron
 * in `batches.ts`.
 *
 * Must stay above the longest legitimate gap between continuations (the
 * external retry ladder's max backoff) so a live retry is never doubled.
 */
export const PENDING_STALE_AFTER_MS = 10 * 60_000;

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

export function mergeUniqueStrings(
  current: readonly string[] | undefined,
  extras: readonly string[],
): string[] {
  const seen = new Set(current ?? []);
  for (const value of extras) {
    if (value) seen.add(value);
  }
  return [...seen];
}

export function normalizeVerifiedEmail(
  email: string | undefined | null,
): string | undefined {
  if (typeof email !== "string") return undefined;
  const normalized = email.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

// Deleted-account billing retention: Dodo customer contact data (email, name,
// phone, billing address) and amounts stay in our records so complaints,
// authority requests, and bookkeeping can still resolve who paid (owner
// decision 2026-09-21; Dodo is not the system of record). Only the internal
// World Monitor identity bridge is stripped — the signed Clerk userId and the
// checkout login-email bridge — because the retained userId tombstone
// (`deleted:<sha256>`) replaces the userId link and the customers row keeps
// the account email.
const INTERNAL_IDENTITY_KEYS = new Set([
  "wm_user_id", "wm_user_id_sig", "wm_login_email", "wm_login_email_sig",
]);

/**
 * Strip internal identity-bridge fields from Dodo-shaped billing payloads
 * while keeping amounts, ids, periods, and the Dodo customer contact block.
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
    if (INTERNAL_IDENTITY_KEYS.has(lower)) {
      continue;
    }
    out[key] = redactBillingPayload(nested);
  }
  return out;
}
