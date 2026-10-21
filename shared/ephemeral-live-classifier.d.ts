/**
 * Classify whether a story is an expiring live-programming teaser rather than
 * a durable event suitable for a delayed digest/brief.
 *
 * @param story - { title, link, description } — only title is currently used;
 * link and description are accepted for API symmetry with other classifiers.
 * @returns true = ephemeral live coverage (exclude from the brief).
 */
export function classifyEphemeralLiveCoverage(story: {
  title?: unknown;
  link?: unknown;
  description?: unknown;
}): boolean;
