// Type declarations for shared/brief-envelope.js.
//
// The envelope is the integration boundary between the per-user brief
// composer (Railway worker, future Phase 3) and every consumer surface:
// the hosted magazine edge route, the dashboard panel preview RPC, the
// email teaser renderer, the carousel renderer, and the Tauri in-app
// reader. All consumers read the same brief:{userId}:{issueDate} Redis
// key and bind to this contract.
//
// Intentionally NOT wrapped in the seed-envelope `_seed` frame. A brief
// is 1 producer -> 1 user -> 1 read (7-day TTL), not a global public
// seed; reusing `_seed` here invites code that mis-applies seed
// invariants (staleness gating, api/health.js SEED_META pairing, etc.)
// to per-user keys. The version constant lives on the envelope root.
//
// Forbidden fields: importanceScore, primaryLink, pubDate, and any AI
// model / provider / cache timestamp strings must NOT appear in
// BriefEnvelope.data. They exist upstream in news:insights:v1 but are
// stripped at compose time. See PR #3143 for the notify-endpoint fix
// that established this rule.

export const BRIEF_ENVELOPE_VERSION: 3;

/**
 * Versions the renderer accepts from Redis on READ. Always contains
 * the current BRIEF_ENVELOPE_VERSION plus any versions still live in
 * the 7-day TTL window. Composer writes ONLY the current version —
 * this is a read-side compatibility shim.
 */
export const SUPPORTED_ENVELOPE_VERSIONS: ReadonlySet<number>;

/**
 * Severity ladder. Four values, no synonyms. `critical` and `high`
 * render with the highlight treatment; `medium` and `low` render
 * plain. See HIGHLIGHTED_LEVELS in the renderer.
 */
export type BriefThreatLevel = 'critical' | 'high' | 'medium' | 'low';

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
  /**
   * Non-personalised lead for the share-URL surface (v3+). Generated
   * by `generateDigestProsePublic` with profile/greeting stripped.
   * The renderer's public-mode lead block reads this when present
   * and OMITS the pull-quote when absent — never falls back to the
   * personalised `lead` (which would leak watched-asset/region
   * context). Optional for v2-envelope back-compat through the
   * 7-day TTL window.
   */
  publicLead?: string;
  /**
   * Non-personalised "signals to watch" array for the share-URL
   * surface (v3+). The personalised `signals` array is generated
   * with `ctx.profile` set, so its phrasing can echo a user's
   * watched assets / regions ("Watch for OPEC headlines on your
   * Saudi exposure"). The public-share renderer MUST substitute
   * `publicSignals` (or omit the signals page entirely when absent)
   * — never serve the personalised `signals` to anonymous readers.
   */
  publicSignals?: string[];
  /**
   * Non-personalised threads array for the share-URL surface (v3+).
   * Threads are mostly content-derived but the prompt instructs the
   * model to surface clusters that align with user interests; in
   * personalised mode that bias can leak. The public-share renderer
   * substitutes `publicThreads` when present, falls back to a
   * category-derived stub otherwise — never serves the personalised
   * `threads` to anonymous readers.
   */
  publicThreads?: BriefThread[];
}

export interface BriefStory {
  /** Editorial category label. */
  category: string;
  /** ISO-2 country code (or composite like "IL / LB"). */
  country: string;
  threatLevel: BriefThreatLevel;
  headline: string;
  description: string;
  /** Publication/wire attribution (rendered as the anchor text). */
  source: string;
  /**
   * Outgoing link to the original article. Required on v2 envelopes
   * and must parse as an absolute https/http URL. Absent on v1
   * envelopes still living in the 7-day TTL window; the renderer
   * degrades to a plain (unlinked) source line for those. No
   * importanceScore / pubDate / briefModel — those upstream fields
   * remain banned in `data`.
   */
  sourceUrl?: string;
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
 * Canonical envelope stored at brief:{userId}:{issueDate} in Redis.
 * Renderer + future composer + future consumers must all pin to
 * `version === BRIEF_ENVELOPE_VERSION` at runtime — see the consumer
 * drift incident (PR #3139) for why.
 */
export interface BriefEnvelope {
  version: typeof BRIEF_ENVELOPE_VERSION;
  /** Unix ms when the envelope was composed. Informational only. */
  issuedAt: number;
  data: BriefData;
}
