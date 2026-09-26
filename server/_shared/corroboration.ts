/**
 * Single-publisher and tier-4-only flagging (#6419 step 2).
 *
 * The one place the rule lives. Every surface builds a ClaimEvidence through
 * evidenceFromCluster, evidenceFromItem, or a literal `grouped` over labels it
 * already holds, and never re-derives the rule. The verdict describes
 * coverage, not accuracy: it never says a claim is true or false.
 */
import {
  PUBLISHER_FAMILIES,
  countPublisherFamilies,
  publisherFamilyFor,
  publisherNameForFamily,
} from '../../shared/publisher-families.js';
import { TIER_MEANING, declaredSourceTier, type DeclaredTier } from './source-tiers';

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

/** The labels every judgment about a claim reads. Blank labels name no publisher. */
function claimLabels(evidence: ClaimEvidence): string[] {
  return (evidence.kind === 'grouped' ? evidence.labels : [evidence.label])
    .filter((label) => publisherFamilyFor(label) !== '');
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
  const labels = claimLabels(evidence);
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

/** One publisher family behind a claim, and the tier its seen labels declare. */
export type Publisher = {
  readonly family: string;
  /** The curated publisher name, or the feed label itself when no family is curated. */
  readonly name: string;
  /** Best tier declared among this claim's labels in the family; null when none declares one. Never defaulted to 4. */
  readonly tier: DeclaredTier | null;
  /** Distinct labels seen, first-seen order: what the tier was read from. */
  readonly labels: readonly string[];
};

/** Tier ascending, undeclared last, then name. */
export type PublisherRoster = readonly Publisher[];

const tierRank = (tier: DeclaredTier | null) => tier ?? 5;

/**
 * The publishers behind a claim, from the same labels assessCorroboration
 * reads, so roster.length is the verdict's seen-family count by construction.
 * A server count above it means publishers this caller cannot list.
 */
export function publisherRoster(evidence: ClaimEvidence): PublisherRoster {
  const byFamily = new Map<string, { labels: string[]; tier: DeclaredTier | null }>();
  for (const label of claimLabels(evidence)) {
    const family = publisherFamilyFor(label);
    const entry = byFamily.get(family) ?? { labels: [], tier: null };
    if (!entry.labels.includes(label)) entry.labels.push(label);
    const tier = declaredSourceTier(label);
    if (tier !== null && (entry.tier === null || tier < entry.tier)) entry.tier = tier;
    byFamily.set(family, entry);
  }
  return [...byFamily].map(([family, { labels, tier }]): Publisher => ({
    family,
    name: Object.prototype.hasOwnProperty.call(PUBLISHER_FAMILIES, family) ? publisherNameForFamily(family) : labels[0]!.trim(),
    tier,
    labels,
  })).sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || a.name.localeCompare(b.name, 'en'));
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

/** Wire rosters list at most this many publishers, like the `sources` list beside them. */
export const PUBLISHER_ROSTER_CAP = 8;

/**
 * Wire rosters list at most this many feed labels per publisher. Labels that
 * differ only in case fold into one family, so the label count is otherwise
 * unbounded by the family count.
 */
export const PUBLISHER_ROSTER_LABEL_CAP = 4;

/**
 * Wire roster strings are capped so a full roster on every cluster fits the MCP
 * output budget. The longest configured label or publisher name fits whole; a
 * test holds the tables to it.
 */
export const PUBLISHER_ROSTER_STRING_MAX_BYTES = 40;

function capUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    const size = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += character.length;
  }
  return value.slice(0, end);
}

export type PublisherJson = { name: string; tier: DeclaredTier | null; labels: string[]; labelsUnlisted: number };
export type PublisherRosterJson = { publishers: PublisherJson[]; publishersUnlisted: number };

/**
 * publishersUnlisted counts every publisher the verdict knows of that the list
 * omits: those past the cap, and those the digest counted but this caller
 * cannot name. publishers.length + publishersUnlisted equals the verdict's
 * publisher count whenever the verdict is known.
 */
export function toPublisherRosterJson(roster: PublisherRoster, verdict: Corroboration): PublisherRosterJson {
  const cap = (value: string) => capUtf8(value, PUBLISHER_ROSTER_STRING_MAX_BYTES);
  const publishers = roster.slice(0, PUBLISHER_ROSTER_CAP)
    .map(({ name, tier, labels }) => ({
      name: cap(name),
      tier,
      labels: labels.slice(0, PUBLISHER_ROSTER_LABEL_CAP).map(cap),
      labelsUnlisted: Math.max(0, labels.length - PUBLISHER_ROSTER_LABEL_CAP),
    }));
  const knownTotal = verdict.state === 'unknown' ? 0 : verdict.publishers;
  return {
    publishers,
    publishersUnlisted: Math.max(0, Math.max(roster.length, knownTotal) - publishers.length),
  };
}

const TIER_LEGEND = ([1, 2, 3, 4] as const).map((tier) => `${tier} ${TIER_MEANING[tier]}`).join('; ');

export const DECLARED_TIER_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: ['integer', 'null'],
  enum: [1, 2, 3, 4, null],
  description: `Tier declared for this source in WorldMonitor's source tables: ${TIER_LEGEND}. null means not declared, never tier 4. Tiers rank sources; they do not judge a claim.`,
});

/** Spread into every MCP tool row that emits a publisher roster. */
export const PUBLISHER_ROSTER_OUTPUT_PROPERTIES: Readonly<Record<string, unknown>> = Object.freeze({
  publishers: {
    type: 'array',
    description: `Distinct publisher families behind this claim, from the same source labels as corroboration: best declared tier first, undeclared last, then name. Up to ${PUBLISHER_ROSTER_CAP}.`,
    items: {
      type: 'object',
      required: ['name', 'tier', 'labels', 'labelsUnlisted'],
      properties: {
        name: { type: 'string', description: `Publisher name, or the feed label when no publisher family is curated. At most ${PUBLISHER_ROSTER_STRING_MAX_BYTES} UTF-8 bytes.` },
        tier: { ...DECLARED_TIER_SCHEMA, description: `Best tier declared among this claim's labels for the publisher: ${TIER_LEGEND}. null means none is declared, never tier 4. Tiers rank sources; they do not judge the claim.` },
        labels: { type: 'array', items: { type: 'string' }, description: `Feed labels seen for this publisher, first seen first, up to ${PUBLISHER_ROSTER_LABEL_CAP}. The tier is read from every seen label, listed or not. Each at most ${PUBLISHER_ROSTER_STRING_MAX_BYTES} UTF-8 bytes; the sources list carries the full label.` },
        labelsUnlisted: { type: 'integer', minimum: 0, description: 'Feed labels seen for this publisher beyond those labels lists.' },
      },
    },
  },
  publishersUnlisted: {
    type: 'integer',
    minimum: 0,
    description: `Publishers counted in corroboration.publishers that publishers does not name: those past the first ${PUBLISHER_ROSTER_CAP}, and those the digest counted whose feed labels this response does not carry. publishers.length + publishersUnlisted equals corroboration.publishers when corroboration.state is not unknown.`,
  },
});
