/**
 * #4917 — non-due synthesis reuse decision.
 *
 * The compose pass (`composeAndStoreBriefForUser`) runs for EVERY eligible
 * user every ~30-min tick so the dashboard "Latest Brief" preview stays
 * fresh — but the canonical synthesis + public-lead calls inside it are
 * paid LLM generations whose cache key includes the accumulator pool hash,
 * which churns as stories arrive. Pre-fix, a weekly subscriber's preview
 * could burn up to ~48 paid syntheses/day that no email ever used.
 *
 * When NO candidate rule is due this tick, the prose from the user's
 * previously stored envelope is reused instead — provided it is young
 * enough AND still grounds against the CURRENT story pool. Due ticks
 * always synthesize fresh: delivered digests never carry reused prose.
 *
 * Pure module: no I/O. The orchestrator resolves the prior envelope from
 * Upstash (`brief:latest:{userId}` → `brief:{userId}:{slot}`) and passes
 * it here.
 */

import { checkLeadGrounding } from './brief-llm.mjs';

// Default freshness budget for reused prose on non-due ticks. Overridable
// via DIGEST_NONDUE_SYNTHESIS_REUSE_MIN (minutes; 0 disables reuse and
// restores the every-tick synthesis behavior).
export const DEFAULT_NONDUE_SYNTHESIS_REUSE_MIN = 360;

/**
 * Decide whether a prior envelope's prose can stand in for a fresh
 * synthesis on a non-due tick.
 *
 * @param {object|null} priorEnvelope Parsed brief envelope (or null).
 * @param {{ nowMs: number; maxAgeMs: number; currentStories: Array<{ headline?: string }> }} opts
 *   `currentStories` is the SYNTHESIS-shaped pool ({ headline, ... }) the
 *   fresh path would have prompted with — grounding must be judged against
 *   what the user will actually see this tick.
 * @returns {{ reuse: false; reason: string } | {
 *   reuse: true; reason: 'ok'; ageMs: number;
 *   synthesis: { lead: string; threads: unknown[]; signals: unknown[] };
 *   publicLead: { lead: string; threads: unknown[]; signals: unknown[] } | null;
 * }}
 */
export function resolveNonDueSynthesisReuse(priorEnvelope, { nowMs, maxAgeMs, currentStories }) {
  if (!priorEnvelope || typeof priorEnvelope !== 'object') {
    return { reuse: false, reason: 'no_prior_envelope' };
  }
  const issuedAt = priorEnvelope.issuedAt;
  if (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt)) {
    return { reuse: false, reason: 'no_issued_at' };
  }
  const ageMs = nowMs - issuedAt;
  // Negative age = clock skew or a corrupted row; treat as unusable rather
  // than "infinitely fresh".
  if (ageMs < 0 || ageMs > maxAgeMs) {
    return { reuse: false, reason: 'stale' };
  }
  const digest = priorEnvelope.data?.digest;
  const lead = typeof digest?.lead === 'string' ? digest.lead.trim() : '';
  // Floor mirrors the fresh path's notion of a substantive lead — a
  // missing/short lead means the prior compose degraded; regenerate.
  if (lead.length < 40) {
    return { reuse: false, reason: 'no_lead' };
  }
  const synthesis = {
    lead,
    threads: Array.isArray(digest.threads) ? digest.threads : [],
    signals: Array.isArray(digest.signals) ? digest.signals : [],
  };
  // The reused lead must still be ABOUT the current pool. A rotated pool —
  // or an L3 stub lead, which carries no proper-noun anchors — fails here
  // and the caller pays a fresh generation. Reuse never ships prose the
  // fresh path's own grounding gate would reject.
  if (!checkLeadGrounding(synthesis, currentStories)) {
    return { reuse: false, reason: 'ungrounded' };
  }
  const publicLeadText = typeof digest.publicLead === 'string' ? digest.publicLead.trim() : '';
  const publicLead = publicLeadText.length > 0
    ? {
        lead: publicLeadText,
        threads: Array.isArray(digest.publicThreads) ? digest.publicThreads : [],
        signals: Array.isArray(digest.publicSignals) ? digest.publicSignals : [],
      }
    : null;
  return { reuse: true, reason: 'ok', ageMs, synthesis, publicLead };
}
