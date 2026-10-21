/**
 * Tape Claim: the label a market surface may show for a quote, bar, or stream.
 * A configured provider key is not a tape. Licensed-live requires a separate
 * commercial display/rebroadcast confirmation that no current source has.
 *
 * Distinct from Panel.setDataBadge('live'), which means a fresh fetch vs cache.
 */

export const TAPE_CLAIMS = [
  'unconfigured',
  'delayed_unverified',
  // Vocabulary term (see CONCEPTS.md). No first-party source publishes a
  // settled end-of-day bar yet, so the resolver never returns it; it exists so
  // a future EOD feed has a name that is not 'delayed'.
  'end_of_day',
  'historical',
  'stale',
  'licensed_live',
] as const;

export type TapeClaim = (typeof TAPE_CLAIMS)[number];

export type MarketTapeSource = 'yahoo' | 'finnhub' | 'seed';

export type MarketTapeClaimInput = {
  source: MarketTapeSource;
  keyConfigured: boolean;
  /** Must be the operator's confirmed display/rebroadcast right, not key presence. */
  realtimeDisplayConfirmed?: boolean;
  /**
   * When the row was produced. Without this the resolver cannot distinguish a
   * fresh quote from a cached one, so it could never return 'stale' — a
   * reassuring label on arbitrarily old data. Pair with `maxFreshMs`.
   */
  asOfMs?: number;
  /** Age beyond which the row is no longer describable as current. */
  maxFreshMs?: number;
  /** Injectable clock; defaults to Date.now(). */
  nowMs?: number;
};

const TAPE_CLAIM_LABEL: Record<TapeClaim, string> = {
  unconfigured: 'Data source not configured',
  delayed_unverified: 'Delayed / unverified',
  end_of_day: 'End of day',
  historical: 'Historical snapshot',
  stale: 'Stale',
  licensed_live: 'Licensed live',
};

export function tapeClaimLabel(claim: TapeClaim): string {
  return TAPE_CLAIM_LABEL[claim];
}

function isStale(input: MarketTapeClaimInput): boolean {
  const { asOfMs, maxFreshMs, nowMs } = input;
  if (typeof asOfMs !== 'number' || typeof maxFreshMs !== 'number') return false;
  if (!Number.isFinite(asOfMs) || !Number.isFinite(maxFreshMs)) return false;
  return (nowMs ?? Date.now()) - asOfMs > maxFreshMs;
}

/**
 * Resolve the honest tape claim for a market source.
 *
 * Order matters, and it is the opposite of "most reassuring wins":
 *   1. An unconfigured source cannot make any claim.
 *   2. A row past its freshness budget is stale, whatever its provenance —
 *      including under a rebroadcast right. A licence is a property of the
 *      vendor relationship, not of a cached row.
 *   3. Provenance that can never be live (Yahoo, seed) is classified next, so
 *      the operator flag cannot promote a snapshot to a live tape.
 *   4. Only then may a confirmed display/rebroadcast right claim licensed-live.
 */
export function tapeClaimForMarketSource(input: MarketTapeClaimInput): TapeClaim {
  const { source, keyConfigured, realtimeDisplayConfirmed } = input;

  if (source !== 'yahoo' && !keyConfigured) {
    return 'unconfigured';
  }

  if (isStale(input)) {
    return 'stale';
  }

  // Yahoo is never a licensed tape, and a seeded snapshot is history — neither
  // is reclassifiable by the operator flag.
  if (source === 'yahoo') {
    return 'delayed_unverified';
  }

  if (source === 'seed') {
    return 'historical';
  }

  if (realtimeDisplayConfirmed === true) {
    return 'licensed_live';
  }

  return 'delayed_unverified';
}
