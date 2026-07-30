/**
 * Data-export gate (plan 2026-07-25-001, KTD2) and dashboard tab cap (KTD8).
 *
 * Pure decision chain for the dashboard + country-brief data exports, plus the
 * catalog-activation probe that decides whether the gate exists at all. The tab
 * cap is a sibling resolver over the SAME inputs and the SAME activation
 * signal, so the two takeaways can never disagree about who is entitled.
 *
 * Why a dedicated resolver instead of `hasFeature('dataExport')`: that helper
 * coerces `undefined → false` (src/services/entitlements.ts:163), i.e. it FAILS
 * CLOSED — the exact opposite of what this gate needs. A late, failed or
 * skipped entitlement snapshot must never lock a paying customer out of their
 * own data (post-mortem: src/app/panel-layout.ts:710-735). `hasPremiumAccess()`
 * is equally wrong in the other direction: it is true for every Pro subscriber,
 * and export is a Pro Business takeaway.
 *
 * MUST stay a leaf that only imports the zero-import `billing-state` module: it
 * is unit-tested under `tsx --test` (no jsdom, no Vite globals), and both
 * services and the app layer import it.
 */

import { getBillingGateOverride, type BillingUxState } from './billing-state';

/**
 * Locked-state reasons. Values mirror the `PanelGateReason` string enum in
 * panel-gating.ts (kept as plain strings here so this module stays a leaf —
 * same arrangement as `BillingGateOverride`). panel-gating.ts owns the
 * exhaustive mapping back to the enum.
 */
export type ExportGateLockReason =
  | 'anonymous'
  | 'free_tier'
  | 'payment_on_hold'
  | 'renewal_pending'
  | 'renewal_failed'
  | 'lapsed';

/** The entitlement fields the two chains read, from a LOADED snapshot. */
export interface ExportGateFeatures {
  tier: number;
  /**
   * Undefined on rows served through the 15-minute server-side entitlement
   * cache, whose staleness check does not key on this field. See the tier >= 2
   * fail-open below.
   */
  dataExport?: boolean;
  /**
   * Per-plan dashboard allowance (KTD8). Required in the schema, the cache
   * validator and the client type, so unlike `dataExport` there is no legacy
   * fail-open branch — but a stored row may lag the catalog, and the cap
   * deliberately tracks the row. `-1` is the catalog's unlimited sentinel.
   */
  maxDashboards: number;
}

export interface ExportGateInputs {
  /** The served product catalog exposes a purchasable `pro_business` group. */
  gateActive: boolean;
  /** Desktop runtime with WORLDMONITOR_API_KEY configured. */
  desktopKeyPresent: boolean;
  /** Clerk auth still resolving (the boot default — auth-state.ts:19). */
  authPending: boolean;
  signedIn: boolean;
  /** Loaded entitlement features, or null when no snapshot has arrived. */
  features: ExportGateFeatures | null;
  /** Billing UX state, used to refine a generic upgrade denial (#4771). */
  billingState: BillingUxState;
}

export type ExportGateVerdict =
  | {
      locked: false;
      /**
       * True when the entitlement chain WOULD lock but the gate is not active
       * yet. The caller uses this to kick `primeExportGateActivation()` lazily,
       * so entitled users never pay for the catalog probe.
       */
      pendingActivation: boolean;
    }
  | { locked: true; reason: ExportGateLockReason };

/**
 * The entitlement chain on its own, independent of catalog activation.
 * Returns null when the user may export.
 *
 * Order matters — every step above the snapshot check is an "unknown", and an
 * unknown is NEVER locked:
 *   1. desktop API key  → allow (no Clerk session exists on that path)
 *   2. auth pending     → allow (cookie-backed users hydrate up to 4s later)
 *   3. signed out       → LOCK, anonymous (the only affirmative denial we can
 *                         make without an entitlement snapshot)
 *   4. no snapshot      → allow (late / failed / skipped Convex subscription)
 *   5. dataExport true  → allow
 *   6. dataExport undefined AND tier >= 2 → allow (PERMANENT legacy fail-open,
 *      mirroring the apiDailyAllowance precedent; an explicit `false` is never
 *      a stale row, so it still locks)
 *   7. otherwise        → LOCK, refined by billing state so a customer with
 *      stale paid evidence sees "update payment" instead of an upsell.
 */
export function resolveExportLock(input: ExportGateInputs): ExportGateLockReason | null {
  if (input.desktopKeyPresent) return null;
  if (input.authPending) return null;
  if (!input.signedIn) return 'anonymous';

  const features = input.features;
  if (features === null) return null;
  if (features.dataExport === true) return null;
  if (features.dataExport === undefined && features.tier >= 2) return null;

  return getBillingGateOverride(input.billingState) ?? 'free_tier';
}

/**
 * Full verdict: the entitlement chain gated on catalog activation (R10). The
 * takeaway can only bite once Pro Business is actually purchasable, so the two
 * flip together regardless of PR/deploy timing.
 */
export function resolveExportGate(input: ExportGateInputs): ExportGateVerdict {
  const reason = resolveExportLock(input);
  if (reason === null) return { locked: false, pendingActivation: false };
  if (!input.gateActive) return { locked: false, pendingActivation: true };
  return { locked: true, reason };
}

// ---------------------------------------------------------------------------
// Dashboard tab cap (KTD8)
// ---------------------------------------------------------------------------

/**
 * Dashboard allowance applied to users we affirmatively know are unentitled —
 * i.e. signed-out visitors, who have no entitlement row to read. Mirrors
 * `FREE_FEATURES.maxDashboards` in convex/config/productCatalog.ts; the drift
 * guard lives in tests/tab-cap.test.mts.
 */
export const FREE_TAB_CAP = 3;

export type TabCapVerdict =
  | {
      allowed: true;
      /** Resolved allowance, or null when this state is uncapped. */
      cap: number | null;
      /** See ExportGateVerdict.pendingActivation — same lazy-probe contract. */
      pendingActivation: boolean;
    }
  | { allowed: false; cap: number; reason: ExportGateLockReason };

const UNCAPPED: TabCapVerdict = { allowed: true, cap: null, pendingActivation: false };

function decideTabCap(
  input: ExportGateInputs,
  currentTabCount: number,
  cap: number,
  reason: ExportGateLockReason,
): TabCapVerdict {
  if (currentTabCount < cap) return { allowed: true, cap, pendingActivation: false };
  if (!input.gateActive) return { allowed: true, cap, pendingActivation: true };
  return { allowed: false, cap, reason };
}

/**
 * May this session create ANOTHER dashboard tab? Creation-only by construction:
 * the verdict carries no removal instruction, so a user sitting above their cap
 * (plan downgrade, allowance lowered, tabs created during a null-snapshot
 * window) keeps every tab they already have.
 *
 * The chain's first four steps are `resolveExportLock`'s verbatim — every step
 * above the snapshot check is an "unknown", and an unknown is never capped:
 *   1. desktop API key → uncapped
 *   2. auth pending    → uncapped
 *   3. signed out      → the free cap, denied with the anonymous reason
 *   4. no snapshot     → uncapped (re-evaluated on the next entitlement event)
 *   5. loaded snapshot → `features.maxDashboards`, refined by billing state so
 *      a customer with stale paid evidence sees "update payment", not an upsell
 */
export function resolveTabCap(input: ExportGateInputs, currentTabCount: number): TabCapVerdict {
  if (input.desktopKeyPresent) return UNCAPPED;
  if (input.authPending) return UNCAPPED;
  if (!input.signedIn) return decideTabCap(input, currentTabCount, FREE_TAB_CAP, 'anonymous');

  const features = input.features;
  if (features === null) return UNCAPPED;

  const cap = features.maxDashboards;
  // `-1` is the catalog's unlimited sentinel (Enterprise). A non-numeric value
  // can only come from a malformed row — the type says required — and an
  // unknown allowance must never cap anyone.
  if (!Number.isFinite(cap) || cap < 0) return UNCAPPED;

  return decideTabCap(
    input,
    currentTabCount,
    cap,
    getBillingGateOverride(input.billingState) ?? 'free_tier',
  );
}

// ---------------------------------------------------------------------------
// Catalog activation probe
// ---------------------------------------------------------------------------

const CATALOG_ENDPOINT = '/api/product-catalog';
const CATALOG_TIMEOUT_MS = 5000;
const PRO_BUSINESS_MARKER = 'probusiness';

/**
 * Identity fields only. Marketing copy (`features`, `description`) is
 * deliberately NOT scanned: a Pro card that upsells "upgrade to Pro Business"
 * must not activate the gate.
 */
const TIER_IDENTITY_FIELDS = ['id', 'group', 'tierGroup', 'planKey', 'localeKey', 'name'] as const;

function normalizeIdentity(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
}

/**
 * Does a served `/api/product-catalog` payload expose the Pro Business group?
 *
 * The endpoint's tier objects carry no single stable group key across the
 * mirrors (edge fallback vs. Railway relay payload), so every plausible
 * identity field is normalized and matched — `pro_business`, `proBusiness`,
 * `Pro Business` and `pro_business_monthly` all resolve to the same marker.
 */
export function catalogExposesProBusiness(payload: unknown): boolean {
  const tiers = (payload as { tiers?: unknown } | null)?.tiers;
  if (!Array.isArray(tiers)) return false;
  return tiers.some((tier) => {
    if (typeof tier !== 'object' || tier === null) return false;
    const record = tier as Record<string, unknown>;
    return TIER_IDENTITY_FIELDS.some((field) =>
      normalizeIdentity(record[field]).startsWith(PRO_BUSINESS_MARKER),
    );
  });
}

type CatalogFetch = (input: string, init?: RequestInit) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

let activationProbe: Promise<boolean> | null = null;
let gateActive = false;

/**
 * Synchronous activation flag. False until the probe resolves positively —
 * including on fetch failure — so the export stays available whenever we
 * cannot prove the tier is purchasable.
 */
export function isExportGateActive(): boolean {
  return gateActive;
}

/**
 * Probe the served catalog once per session. Single-flight: the promise is
 * cached, so concurrent callers share one request.
 *
 * `fetch` is called through an arrow wrapper (never `fetch.bind`) so the
 * desktop runtime's patched global is honoured — see AGENTS.md.
 */
export function primeExportGateActivation(fetchImpl?: CatalogFetch): Promise<boolean> {
  if (activationProbe) return activationProbe;

  const doFetch: CatalogFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));
  // `null` = transient failure (offline, blocked, non-2xx, timed out) — the
  // gate stays inactive (fail-open) but the probe is NOT cached, so the next
  // prime retries instead of pinning a startup blip for the whole session.
  // Only a definitive verdict from a parsed catalog payload is cached.
  const probe = (async (): Promise<boolean | null> => {
    try {
      const res = await doFetch(CATALOG_ENDPOINT, { signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) });
      if (!res.ok) return null;
      return catalogExposesProBusiness(await res.json());
    } catch {
      return null;
    }
  })().then((verdict) => {
    if (verdict === null) {
      if (activationProbe === probe) activationProbe = null;
      gateActive = false;
      return false;
    }
    gateActive = verdict;
    return verdict;
  });
  activationProbe = probe;

  return activationProbe;
}

/** Test-only: clears the cached probe and activation flag. */
export function __resetExportGateActivationForTests(): void {
  activationProbe = null;
  gateActive = false;
}
