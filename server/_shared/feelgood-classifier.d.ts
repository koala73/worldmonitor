/**
 * Classify a story as feel-good / lifestyle vs hard news. Single
 * classifier shared by the ingest path (list-feed-digest.ts — stamps
 * `isFeelGood` on the story:track:v1 row) and the read path
 * (buildDigest — re-classifies residue). Sibling to classifyOpinion.
 * Uses title, link (URL), and description. See
 * docs/plans/2026-05-17-001-fix-feelgood-lifestyle-filter-plan.md.
 *
 * @param story - { title, link, description } — any may be missing.
 * @returns true = feel-good / lifestyle (exclude from the brief).
 */
export function classifyFeelGood(story: {
  title?: unknown;
  link?: unknown;
  description?: unknown;
}): boolean;
