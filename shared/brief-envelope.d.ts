// Type declarations for shared/brief-envelope.js.
//
// The envelope is the integration boundary between the per-user brief
// composer (Railway worker, future Phase 3) and every consumer surface:
// the hosted magazine edge route, the dashboard panel preview RPC, the
// email teaser renderer, the carousel renderer, and the Tauri in-app
// reader. All consumers read the same brief:{userId}:{issueDate} Redis
// key and bind to this contract.
//
// Forbidden fields: importanceScore, primaryLink, pubDate, and any AI
// model / provider / cache timestamp strings must NOT appear in
// BriefEnvelope.data. They exist upstream in news:insights:v1 but are
// stripped at compose time. See PR #3143 for the notify-endpoint fix
// that established this rule.

export const BRIEF_ENVELOPE_VERSION: 1;

export type BriefThreatLevel =
  | 'critical'
  | 'high'
  | 'medium'
  | 'moderate'
  | 'low';

export interface BriefUser {
  /** Display name used in the greeting and back-cover chrome. */
  name: string;
  /** IANA timezone string, e.g. "UTC", "Europe/Paris". */
  tz: string;
}

export interface BriefNumbers {
  /** Total story clusters ingested globally in the last 24h. */
  clusters: number;
  /** Multi-source confirmed events globally in the last 24h. */
  multiSource: number;
  /** Stories surfaced in THIS user's brief. Must equal stories.length. */
  surfaced: number;
}

export interface BriefThread {
  /** Short editorial label, e.g. "Energy", "Diplomacy". */
  tag: string;
  /** One-sentence teaser, no trailing period required. */
  teaser: string;
}

export interface BriefDigest {
  /** e.g. "Good evening." — time-of-day aware in user.tz. */
  greeting: string;
  /** Executive summary paragraph — italic pull-quote in the magazine. */
  lead: string;
  numbers: BriefNumbers;
  /** Threads to watch today. Renderer splits into 03a/03b when > 6. */
  threads: BriefThread[];
  /** Signals-to-watch. The "04 · Signals" page is omitted when empty. */
  signals: string[];
}

export interface BriefStory {
  /** Editorial category label. */
  category: string;
  /** ISO-2 country code (or composite like "IL / LB"). */
  country: string;
  threatLevel: BriefThreatLevel;
  headline: string;
  description: string;
  /** Publication/wire attribution only (no importance score, no URL). */
  source: string;
  /** Per-user LLM-generated rationale. */
  whyMatters: string;
}

export interface BriefData {
  user: BriefUser;
  /** Short issue code, e.g. "17.04". */
  issue: string;
  /** ISO date "YYYY-MM-DD" in user.tz. */
  date: string;
  /** Long-form human date, e.g. "17 April 2026". */
  dateLong: string;
  digest: BriefDigest;
  stories: BriefStory[];
}

/**
 * Canonical envelope stored at brief:{userId}:{issueDate} in Redis. The
 * `_seed` frame matches the global seed-envelope convention (see
 * shared/seed-envelope.js) so existing unwrapEnvelope/wrapEnvelope helpers
 * work unchanged.
 */
export interface BriefEnvelope {
  _seed: {
    version: typeof BRIEF_ENVELOPE_VERSION;
    fetchedAt: number;
    recordCount: number;
  };
  data: BriefData;
}
