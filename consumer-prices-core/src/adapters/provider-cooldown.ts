/**
 * Half-open provider cooldown (#6182).
 *
 * The 2026-08-05 cooldown (#6185) opened after two consecutive transport
 * errors and stayed open for the REMAINDER of the retailer's scrape. That
 * turned one transient blip into a whole-retailer wipeout: on 2026-08-08
 * Tesco GB lost 11 of 12 pages to a single pair of Firecrawl HTTP 500s —
 * every later page failed on `provider-cooldown` without a single call
 * checking whether the provider had recovered (it had).
 *
 * This gate keeps the bounded-retry property (#6182 scope item 7: a known-
 * failing route must not be re-called tightly) but adds recovery: once open,
 * the next `probeInterval` attempts are skipped without a network call, and
 * the attempt after that is allowed through as a PROBE. A successful probe
 * closes the gate; a failed probe re-opens another skip window. Worst case a
 * hard-down provider costs one call per `probeInterval + 1` attempts instead
 * of one per attempt — still bounded, but a recovered provider is back within
 * `probeInterval` attempts instead of never.
 */

const COOLDOWN_OPEN_THRESHOLD = 2;
export const COOLDOWN_PROBE_INTERVAL = 4;

export class ProviderCooldownGate {
  private consecutiveFailures = 0;
  private skipsRemaining = 0;

  constructor(private readonly probeInterval: number = COOLDOWN_PROBE_INTERVAL) {}

  /** Record a transport failure. Returns true when this failure (re)opened the gate. */
  recordFailure(): boolean {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= COOLDOWN_OPEN_THRESHOLD) {
      const wasOpen = this.skipsRemaining > 0;
      this.skipsRemaining = this.probeInterval;
      return !wasOpen;
    }
    return false;
  }

  /**
   * Record a successful call. Returns true when this success CLOSED a
   * cooldown — i.e. the call was the recovery probe (or a success while the
   * gate was open) — so callers can log the open->closed transition with the
   * same visibility recordFailure() gives the opening one. By probe time the
   * skip window is exhausted (`isOpen` is already false), so the failure
   * streak, not the window, is what identifies a recovery.
   */
  recordSuccess(): boolean {
    const closedCooldown = this.consecutiveFailures >= COOLDOWN_OPEN_THRESHOLD;
    this.consecutiveFailures = 0;
    this.skipsRemaining = 0;
    return closedCooldown;
  }

  /**
   * Consume one attempt slot. True = skip this attempt (cooldown open);
   * false = the attempt may proceed — either the gate is closed, or the skip
   * window is exhausted and this attempt is the recovery probe.
   */
  consumeSkip(): boolean {
    if (this.skipsRemaining > 0) {
      this.skipsRemaining--;
      return true;
    }
    return false;
  }

  /** Open = attempts are currently being skipped (peek, does not consume). */
  get isOpen(): boolean {
    return this.skipsRemaining > 0;
  }
}
