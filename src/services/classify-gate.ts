/**
 * Session gate for AI event classification (#4865).
 *
 * classify-event was premium-gated server-side (#4779) but the client kept
 * enqueueing a classification RPC for every incoming headline regardless of
 * entitlement: signed-in free users generated ~95k tier_403s/day (the batch
 * loop had no 403 handling at all) and anonymous users ~475k 401s/day (the
 * 120s-pause loop retried forever as new headlines refilled the queue).
 *
 * Two mechanisms, both consulted by threat-classifier before any network
 * attempt; a denial resolves to the keyword-classification fallback:
 *
 *   1. Entitlement probe — injected by threat-classifier (wired to
 *      panel-gating's `hasPremiumAccess`, the dual-signal source of truth).
 *      Kills the flood at the source for anon/free principals: zero requests.
 *      Fails OPEN when the probe throws or is unconfigured — the server still
 *      gates, and a client-side gating bug must never silence classification
 *      for paying users.
 *
 *   2. Timed suppression — set by the batch loop on a server 403. Covers
 *      entitlement-signal drift (probe says entitled, server disagrees):
 *      without it, drift recreates the flood at headline-arrival rate. A
 *      timed window rather than a session-permanent kill so a mid-session
 *      upgrade self-heals on the next enqueue after the window — no
 *      auth-event plumbing, worst case one probe request per window.
 *
 * Pure module (zero imports) so it is loadable under `tsx --test` —
 * threat-classifier itself imports @/utils and cannot be, hence the wiring
 * is covered by source-grep assertions (tests/classify-entitlement-gate).
 */

export const CLASSIFY_SUPPRESS_MS = 15 * 60 * 1000;

type EntitlementProbe = () => boolean;

let entitlementProbe: EntitlementProbe | null = null;
let suppressedUntil = 0;

/** Inject the entitlement signal. Called once at threat-classifier init. */
export function configureClassifyGate(probe: EntitlementProbe): void {
  entitlementProbe = probe;
}

/**
 * Whether an AI-classification attempt may be enqueued right now.
 * Suppression wins over the probe; an unconfigured/throwing probe allows.
 */
export function canAttemptAiClassification(now: number = Date.now()): boolean {
  if (now < suppressedUntil) return false;
  if (!entitlementProbe) return true;
  try {
    return entitlementProbe();
  } catch {
    return true;
  }
}

/** Suppress all attempts for CLASSIFY_SUPPRESS_MS (called on a server 403). */
export function suppressAiClassification(now: number = Date.now()): void {
  suppressedUntil = now + CLASSIFY_SUPPRESS_MS;
}

export function __resetClassifyGateForTests(): void {
  entitlementProbe = null;
  suppressedUntil = 0;
}
