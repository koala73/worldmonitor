/**
 * Classify a story as opinion/analysis vs hard news. Single classifier
 * shared by the ingest path (list-feed-digest.ts — stamps `isOpinion`
 * on the story:track:v1 row) and the read path (buildDigest —
 * re-classifies residue). Uses title, link (URL), and description.
 * See docs/plans/2026-05-14-001-…-plan.md (F3, Phase 3).
 *
 * @param story - { title, link, description } — any may be missing.
 * @returns true = opinion/analysis (exclude from the brief).
 */
export function classifyOpinion(story: {
  title?: unknown;
  link?: unknown;
  description?: unknown;
}): boolean;
