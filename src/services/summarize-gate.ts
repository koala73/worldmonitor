/**
 * Session gate for server-side news summarization (#4913).
 *
 * summarize-article's LLM spend was premium-gated server-side (#4675/#4687)
 * but the client kept dispatching the RPC for every summarize attempt
 * regardless of entitlement — and the ollama→groq→openrouter provider
 * fan-out routes through the SAME gated endpoint, so one attempt burned up
 * to three doomed requests (console/Sentry 401 noise on every anonymous
 * dashboard) before landing on the browser-T5 fallback it would use anyway.
 *
 * Two mechanisms, both consulted by summarization.ts before any network
 * attempt; a denial falls through to the browser-T5 provider (the designed
 * anon path — free users keep their summaries, minus the wasted requests):
 *
 *   1. Entitlement probe — injected by summarization.ts (wired to
 *      panel-gating's `hasPremiumAccess`, the dual-signal source of truth).
 *      Anon/free principals dispatch ZERO server requests. Fails OPEN when
 *      the probe throws or is unconfigured — the server still gates, and a
 *      client-side gating bug must never silence summaries for paying users.
 *
 *   2. Timed suppression — set on a server 403. Covers entitlement-signal
 *      drift (probe says entitled, server disagrees); a timed window rather
 *      than a session-permanent kill so a mid-session upgrade self-heals on
 *      the next attempt after the window. 401 deliberately does NOT suppress:
 *      the only in-practice 401 source once the probe gates anon dispatch is
 *      a signed-in user racing the session bootstrap (see premium-fetch.ts
 *      boot-window note), and benching a Pro user for a full window over a
 *      transient race would visibly degrade their summaries.
 *
 * Pure module (zero imports) so it is loadable under `tsx --test` —
 * summarization.ts itself imports @/services/i18n etc. and cannot be, hence
 * the wiring is covered by source-grep assertions
 * (tests/summarize-entitlement-gate). Deliberately a sibling of
 * classify-gate.ts with separate state: a summarize 403 must not silence
 * classification, and vice versa.
 */

export const SUMMARIZE_SUPPRESS_MS = 15 * 60 * 1000;

type EntitlementProbe = () => boolean;

let entitlementProbe: EntitlementProbe | null = null;
let suppressedUntil = 0;

/** Inject the entitlement signal. Called once at summarization module init. */
export function configureSummarizeGate(probe: EntitlementProbe): void {
  entitlementProbe = probe;
}

/**
 * Whether a server summarization attempt may be dispatched right now.
 * Suppression wins over the probe; an unconfigured/throwing probe allows.
 */
export function canAttemptServerSummarization(now: number = Date.now()): boolean {
  if (now < suppressedUntil) return false;
  if (!entitlementProbe) return true;
  try {
    return entitlementProbe();
  } catch {
    return true;
  }
}

/** Suppress all attempts for SUMMARIZE_SUPPRESS_MS (called on a server 403). */
export function suppressServerSummarization(now: number = Date.now()): void {
  suppressedUntil = now + SUMMARIZE_SUPPRESS_MS;
}

export function __resetSummarizeGateForTests(): void {
  entitlementProbe = null;
  suppressedUntil = 0;
}
