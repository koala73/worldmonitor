/**
 * Single-publisher and tier-4-only flagging (#6419 step 2).
 *
 * The one place the rule lives. Every surface builds a ClaimEvidence through
 * evidenceFromCluster, evidenceFromItem, or a literal `grouped` over labels it
 * already holds, and never re-derives the rule. The verdict describes
 * coverage, not accuracy: it never says a claim is true or false.
 */
import { countPublisherFamilies, publisherFamilyFor } from '../../shared/publisher-families.js';
import { declaredSourceTier } from './source-tiers';

/** What a caller holds about one claim. The variant says whether sibling members are visible. */
export type ClaimEvidence =
  | { readonly kind: 'grouped'; readonly labels: readonly string[]; readonly reportedPublishers: number | null }
  | { readonly kind: 'item'; readonly label: string; readonly reportedPublishers: number | null };

export type Corroboration =
  | { readonly state: 'corroborated'; readonly publishers: number }
  | { readonly state: 'single-publisher'; readonly publishers: 1 }
  | { readonly state: 'tier4-only'; readonly publishers: number }
  | { readonly state: 'unknown' };

export const CORROBORATION_STATES = ['corroborated', 'single-publisher', 'tier4-only', 'unknown'] as const satisfies
  readonly Corroboration['state'][];

const UNKNOWN: Corroboration = { state: 'unknown' };
const SINGLE_PUBLISHER: Corroboration = { state: 'single-publisher', publishers: 1 };

function positiveCount(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : null;
}

/**
 * Rule, in order:
 *  - an item without a server count is unknown: one label says nothing about its siblings;
 *  - a group with no labels is unknown;
 *  - one publisher family is single-publisher, which outranks tier4-only;
 *  - a server count above the seen families, or an item, is corroborated: the
 *    unseen members have unknown tiers, and an unknown tier is never tier 4;
 *  - every seen label declared tier 4 is tier4-only; otherwise corroborated.
 */
export function assessCorroboration(evidence: ClaimEvidence): Corroboration {
  const labels = (evidence.kind === 'grouped' ? evidence.labels : [evidence.label])
    .filter((label) => publisherFamilyFor(label) !== '');
  const seen = countPublisherFamilies(labels);
  const reported = positiveCount(evidence.reportedPublishers);
  if (evidence.kind === 'item' && reported === null) return UNKNOWN;
  if (evidence.kind === 'grouped' && seen === 0) return UNKNOWN;
  const publishers = Math.max(seen, reported ?? 0);
  if (publishers <= 1) return SINGLE_PUBLISHER;
  if ((reported !== null && reported > seen) || evidence.kind === 'item') {
    return { state: 'corroborated', publishers };
  }
  return labels.every((label) => declaredSourceTier(label) === 4)
    ? { state: 'tier4-only', publishers }
    : { state: 'corroborated', publishers };
}

export function evidenceFromCluster(cluster: {
  readonly allItems: readonly { readonly source: string; readonly corroborationCount?: number }[];
}): ClaimEvidence {
  let reported: number | null = null;
  for (const item of cluster.allItems) {
    const count = positiveCount(item.corroborationCount);
    if (count !== null && (reported === null || count > reported)) reported = count;
  }
  return { kind: 'grouped', labels: cluster.allItems.map((item) => item.source), reportedPublishers: reported };
}

/**
 * A seeded brief story (news:insights:v1). `sources` is only the labels that
 * survived the digest's per-category cap, so the digest's origin-aware
 * corroborationCount is the floor on publishers. Non-array or non-string
 * sources are legacy or malformed and contribute nothing.
 */
export function evidenceFromStory(
  story: { readonly sources?: unknown; readonly corroborationCount?: unknown },
): Extract<ClaimEvidence, { kind: 'grouped' }> {
  const labels = Array.isArray(story.sources)
    ? story.sources.filter((label): label is string => typeof label === 'string' && label.length > 0)
    : [];
  const count = typeof story.corroborationCount === 'number' ? story.corroborationCount : null;
  return { kind: 'grouped', labels, reportedPublishers: positiveCount(count) };
}

export function evidenceFromItem(item: { readonly source: string; readonly corroborationCount?: number }): ClaimEvidence {
  return { kind: 'item', label: item.source, reportedPublishers: positiveCount(item.corroborationCount) };
}

/** Wire form for MCP JSON. */
export type CorroborationJson = { state: Corroboration['state']; publishers: number | null };

export function toCorroborationJson(c: Corroboration): CorroborationJson {
  return c.state === 'unknown' ? { state: 'unknown', publishers: null } : { state: c.state, publishers: c.publishers };
}

/** One JSON Schema fragment, spread into every MCP tool that emits `corroboration`. */
export const CORROBORATION_OUTPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  description: 'Coverage of this claim across the sources WorldMonitor monitors. Describes coverage, not accuracy: no state says the claim is true or false.',
  required: ['state', 'publishers'],
  properties: {
    state: {
      type: 'string',
      enum: [...CORROBORATION_STATES],
      description: 'single-publisher: one publisher family carries it. tier4-only: two or more families, every one a declared tier-4 outlet (aggregators and blogs). corroborated: two or more families, not all tier 4. unknown: no evidence to judge. An undeclared tier never counts as tier 4.',
    },
    publishers: {
      type: ['integer', 'null'],
      description: 'Distinct publisher families behind the claim; null when state is unknown.',
    },
  },
});
