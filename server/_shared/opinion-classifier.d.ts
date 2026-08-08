/**
 * Classify a story as non-event brief content vs hard news. The legacy
 * `isOpinion` stamp includes opinion/analysis and historical explainers;
 * the classifier is shared by the ingest path (list-feed-digest.ts) and
 * the read path (buildDigest). Uses title, link (URL), and description.
 * See docs/plans/2026-05-14-001-…-plan.md (F3, Phase 3).
 *
 * @param story - { title, link, description, publishedAt } — any may be missing.
 * @returns true = opinion/analysis or historical explainer (exclude from
 *   the brief).
 */
export function classifyOpinion(story: {
  title?: unknown;
  link?: unknown;
  description?: unknown;
  publishedAt?: unknown;
}): boolean;
