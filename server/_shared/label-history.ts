/**
 * Item-level label history (#9093).
 *
 * WorldMonitor labels each story with how widely it is covered
 * (assessCorroboration). When that label moves between single-publisher and
 * corroborated, the change is recorded here, in the open, with the publishers
 * behind it. The log is append-only and bounded: entries are kept for
 * LABEL_HISTORY_RETENTION_MS and readers drop anything older.
 *
 * Only these two states are logged. tier4-only and unknown depend on which
 * feed labels a cycle happened to keep, so logging them would mostly record
 * churn rather than a change in coverage.
 *
 * The label describes coverage, not accuracy: a change to "corroborated" means
 * more publishers carry the story, not that it was confirmed.
 */
import { publisherFamilyFor } from '../../shared/publisher-families.js';
import {
  assessCorroboration,
  evidenceFromCluster,
  publisherRoster,
  type Corroboration,
} from './corroboration';
import { runRedisPipeline, type RedisPipelineCommand } from './redis';

export const LABEL_HISTORY_STATES = ['single-publisher', 'corroborated'] as const;
export type LabelHistoryState = (typeof LABEL_HISTORY_STATES)[number];

export const LABEL_HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RETENTION_S = LABEL_HISTORY_RETENTION_MS / 1000;

export const LABEL_CHANGES_KEY = 'trust:label-changes:v1';
export const STORY_LABEL_HISTORY_KEY = (storyId: string) => `trust:label-history:v1:${storyId}`;
/** One recorder per story transition: concurrent digest builds must not log it twice. */
const LABEL_CHANGE_GUARD_KEY = (storyId: string, previous: string, next: string) =>
  `trust:label-change-guard:v1:${storyId}:${previous}:${next}`;
const LABEL_CHANGE_GUARD_TTL_S = 15 * 60;

export const LABEL_CHANGES_MAX = 500;
export const STORY_LABEL_HISTORY_MAX = 20;
/** Publishers listed per entry; the count is always complete. */
const ENTRY_PUBLISHERS_MAX = 12;

export const LABEL_COUNTS_KEY = 'trust:label-counts:v1';
/** Counts older than this are not served: the digest that wrote them has stopped. */
export const LABEL_COUNTS_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface LabelCounts {
  /** Epoch ms of the digest build that counted. */
  readonly at: number;
  readonly stories: number;
  readonly corroborated: number;
  readonly singlePublisher: number;
  readonly tier4Only: number;
  readonly unknown: number;
}

export function countLabels(states: Iterable<Corroboration['state']>, at: number): LabelCounts {
  const counts = { at, stories: 0, corroborated: 0, singlePublisher: 0, tier4Only: 0, unknown: 0 };
  for (const state of states) {
    counts.stories += 1;
    if (state === 'corroborated') counts.corroborated += 1;
    else if (state === 'single-publisher') counts.singlePublisher += 1;
    else if (state === 'tier4-only') counts.tier4Only += 1;
    else counts.unknown += 1;
  }
  return counts;
}

export function labelCountsCommand(counts: LabelCounts): RedisPipelineCommand {
  return ['SET', LABEL_COUNTS_KEY, JSON.stringify(counts), 'EX', LABEL_COUNTS_MAX_AGE_MS / 1000];
}

export function parseLabelCounts(raw: unknown, now: number): LabelCounts | null {
  if (typeof raw !== 'string') return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const fields = ['at', 'stories', 'corroborated', 'singlePublisher', 'tier4Only', 'unknown'] as const;
    if (!fields.every((field) => Number.isInteger(value[field]) && (value[field] as number) >= 0)) return null;
    const counts = value as unknown as LabelCounts;
    if (counts.at < now - LABEL_COUNTS_MAX_AGE_MS) return null;
    if (counts.corroborated + counts.singlePublisher + counts.tier4Only + counts.unknown !== counts.stories) return null;
    return counts;
  } catch {
    return null;
  }
}

/** Story-track hash field holding the last recorded label, as `state|publishers`, or UNTRACKED_LABEL. */
export const STORY_LABEL_FIELD = 'corrState';
/**
 * Written when a cycle's label is tier4-only or unknown, so the next tracked
 * label is compared with that, not with an older one: corroborated, then
 * tier4-only, then single-publisher must not log corroborated → single-publisher.
 */
export const UNTRACKED_LABEL = 'untracked';

export interface StoryLabel {
  readonly state: Corroboration['state'];
  readonly publishers: number | null;
  readonly roster: readonly { readonly name: string; readonly tier: number | null }[];
}

export interface LabelChangePublisher {
  readonly name: string;
  /** Declared source tier 1-4; null when no label declares one. */
  readonly tier: number | null;
}

/**
 * One log entry. `corroboration` entries are automatic label changes.
 * `correction` entries are reader reports an operator accepted: they carry the
 * operator's public note as the reason, no label states, and may name a URL
 * instead of a story.
 */
export interface LabelChange {
  readonly storyId: string;
  readonly field: 'corroboration' | 'correction';
  readonly previous: LabelHistoryState | '';
  readonly next: LabelHistoryState | '';
  readonly previousPublishers: number;
  readonly nextPublishers: number;
  readonly at: number;
  /** 'digest' for automatic changes; accepted reports use 'report' (#9093 intake). */
  readonly trigger: 'digest' | 'report';
  readonly reason: string;
  /** Publishers behind the new label, tier first. */
  readonly sources: readonly LabelChangePublisher[];
  readonly title: string;
  readonly link: string;
  /** The story's CRED score (0-100) when the change was recorded, if known. */
  readonly credibilityScore: number | null;
}

/**
 * The publisher label an item counts under: its trusted originating publisher
 * when it has one the family map knows (an aggregator or topic feed carrying
 * Reuters copy counts as Reuters), else its feed label. Mirrors
 * publisherFamilyForItem, which the digest's corroborationCount uses.
 */
function publisherLabel(item: { source: string; originPublisher?: string; originPublisherTrusted?: boolean }): string {
  if (item.originPublisherTrusted === true && typeof item.originPublisher === 'string'
    && publisherFamilyFor(item.originPublisher) !== '') {
    return item.originPublisher;
  }
  return item.source;
}

/** The label a story carries this cycle, from the items the digest kept for it. */
export function storyLabel(
  items: readonly {
    readonly source: string;
    readonly originPublisher?: string;
    readonly originPublisherTrusted?: boolean;
    readonly corroborationCount?: number;
    readonly title?: string;
    readonly description?: string;
  }[],
): StoryLabel {
  // Title and lead feed the same-copy check (#9095), so a reprint counts once
  // here exactly as it does in the News panel (#9213).
  const evidence = evidenceFromCluster({
    allItems: items.map((item) => ({
      source: publisherLabel(item),
      corroborationCount: item.corroborationCount,
      ...(typeof item.title === 'string' ? { title: item.title } : {}),
      ...(typeof item.description === 'string' ? { snippet: item.description } : {}),
    })),
  });
  const corroboration = assessCorroboration(evidence);
  return {
    state: corroboration.state,
    publishers: corroboration.state === 'unknown' ? null : corroboration.publishers,
    roster: publisherRoster(evidence).map((publisher) => ({ name: publisher.name, tier: publisher.tier })),
  };
}

export function encodeStoryLabel(label: StoryLabel): string {
  if (!isLabelHistoryState(label.state) || label.publishers === null) return UNTRACKED_LABEL;
  return `${label.state}|${label.publishers}`;
}

/**
 * #9213: story-track field holding the label a digest variant served this
 * cycle, all four states. Alert and digest text read it, so they show the
 * verdict the dashboard showed instead of recomputing it. Scoped per variant
 * and language because the track row is shared and each variant keeps a
 * different set of a story's feeds.
 */
export const STORY_CORROBORATION_FIELD = (variant: string, lang: string) => `corroboration:${variant}:${lang}`;

/** `state|publishers`, or `unknown`. Read by parseCorroboration in scripts/lib/corroboration-text.cjs. */
export function encodeStoryCorroboration(label: Corroboration | Pick<StoryLabel, 'state' | 'publishers'>): string {
  const publishers = 'publishers' in label ? label.publishers : null;
  return label.state === 'unknown' || publishers === null ? 'unknown' : `${label.state}|${publishers}`;
}

export function decodeStoryLabel(raw: unknown): { state: LabelHistoryState; publishers: number } | null {
  if (typeof raw !== 'string') return null;
  const [state, count] = raw.split('|');
  const publishers = Number(count);
  if (!isLabelHistoryState(state) || !Number.isInteger(publishers) || publishers < 1) return null;
  return { state, publishers };
}

function isLabelHistoryState(value: unknown): value is LabelHistoryState {
  return (LABEL_HISTORY_STATES as readonly unknown[]).includes(value);
}

function reasonFor(next: LabelHistoryState, nextPublishers: number, previousPublishers: number): string {
  if (next === 'corroborated') {
    return `${nextPublishers} publisher families now carry this story (was ${previousPublishers}).`;
  }
  return `Only one publisher family carries this story in the latest digest (was ${previousPublishers}).`;
}

/**
 * The change between the label recorded last cycle and this cycle's, or null
 * when there is none to log: no previous label (a new story), an untracked
 * state on either side, or the same state.
 */
export function labelChangeFor(
  storyId: string,
  previousRaw: unknown,
  current: StoryLabel,
  context: { at: number; title: string; link: string; credibilityScore?: number | null },
): LabelChange | null {
  const previous = decodeStoryLabel(previousRaw);
  if (!previous || !isLabelHistoryState(current.state) || current.publishers === null) return null;
  if (previous.state === current.state) return null;
  return {
    storyId,
    field: 'corroboration',
    previous: previous.state,
    next: current.state,
    previousPublishers: previous.publishers,
    nextPublishers: current.publishers,
    at: context.at,
    trigger: 'digest',
    reason: reasonFor(current.state, current.publishers, previous.publishers),
    sources: current.roster.slice(0, ENTRY_PUBLISHERS_MAX),
    title: context.title,
    link: context.link,
    credibilityScore: typeof context.credibilityScore === 'number' && Number.isFinite(context.credibilityScore) ? Math.round(context.credibilityScore) : null,
  };
}

export function labelChangeCommands(change: LabelChange): RedisPipelineCommand[] {
  const member = JSON.stringify(change);
  const commands: RedisPipelineCommand[] = [
    ['LPUSH', LABEL_CHANGES_KEY, member],
    ['LTRIM', LABEL_CHANGES_KEY, 0, LABEL_CHANGES_MAX - 1],
    ['EXPIRE', LABEL_CHANGES_KEY, RETENTION_S],
  ];
  if (change.storyId) {
    const storyKey = STORY_LABEL_HISTORY_KEY(change.storyId);
    commands.push(
      ['LPUSH', storyKey, member],
      ['LTRIM', storyKey, 0, STORY_LABEL_HISTORY_MAX - 1],
      ['EXPIRE', storyKey, RETENTION_S],
    );
  }
  return commands;
}

/** The log entry for an accepted reader report: the operator's public note, never the reader's text. */
export function correctionEntry(report: { storyId: string; url: string }, publicNote: string, at: number): LabelChange {
  return {
    storyId: report.storyId,
    field: 'correction',
    previous: '',
    next: '',
    previousPublishers: 0,
    nextPublishers: 0,
    at,
    trigger: 'report',
    reason: publicNote,
    sources: [],
    title: '',
    link: report.url,
    credibilityScore: null,
  };
}

/**
 * Append changes, each at most once per guard window: two digest builds racing
 * over the same previous label would otherwise both log it.
 *
 * Returns the story ids whose change this build confirmed appending. The caller
 * persists the new label only for those, so a story whose entry was not
 * written keeps its previous label and the change is detected again next
 * cycle. A build that loses the guard leaves the label to the winner: the
 * winner persists it after a confirmed append, or fails and releases the
 * guard, and the next cycle detects the change again. A failed append releases its guards
 * (best effort) for that retry; when the failure was a timeout after Redis
 * applied the write, the retry can log the change twice, which is preferred
 * to losing it. Never throws.
 */
export async function recordLabelChanges(changes: readonly LabelChange[], deadlineAt = Number.POSITIVE_INFINITY): Promise<Set<string>> {
  const recorded = new Set<string>();
  if (changes.length === 0) return recorded;
  const runPipelineBeforeDeadline = async (commands: RedisPipelineCommand[]) => {
    const remainingMs = deadlineAt - Date.now();
    if (!(remainingMs > 0)) return [];
    return runRedisPipeline(commands, false, Number.isFinite(remainingMs) ? remainingMs : undefined);
  };
  const guardKeys = changes.map((change) => LABEL_CHANGE_GUARD_KEY(change.storyId, change.previous, change.next));
  const guards = await runPipelineBeforeDeadline(
    changes.map((change, i) => ['SET', guardKeys[i]!, String(change.at), 'NX', 'EX', LABEL_CHANGE_GUARD_TTL_S]),
  );
  if (guards.length !== changes.length) return recorded;
  const won = changes.flatMap((_, i) => (guards[i]!.result === 'OK' ? [i] : []));
  if (won.length === 0) return recorded;
  const commands = won.flatMap((i) => labelChangeCommands(changes[i]!));
  const results = await runPipelineBeforeDeadline(commands);
  if (results.length === commands.length && results.every((result) => !result.error)) {
    for (const i of won) recorded.add(changes[i]!.storyId);
  } else {
    await runPipelineBeforeDeadline(won.map((i) => ['DEL', guardKeys[i]!]));
  }
  return recorded;
}

/** Source-credibility tiers (1-4), not account tiers. */
const DECLARED_TIERS: readonly unknown[] = [1, 2, 3, 4];

/**
 * Drop the new label of every story whose change was not recorded, so the
 * story keeps its previous label and the change is detected again next cycle.
 */
export function keepUnrecordedLabels(
  labelByHash: Map<string, string>,
  changes: readonly LabelChange[],
  recorded: ReadonlySet<string>,
): void {
  for (const change of changes) {
    if (!recorded.has(change.storyId)) labelByHash.delete(change.storyId);
  }
}

function asPublisher(raw: unknown): LabelChangePublisher | null {
  if (!raw || typeof raw !== 'object') return null;
  const { name, tier } = raw as { name?: unknown; tier?: unknown };
  if (typeof name !== 'string' || name === '') return null;
  return { name, tier: DECLARED_TIERS.includes(tier as number) ? (tier as number) : null };
}

export function parseLabelChange(raw: unknown, now: number): LabelChange | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  const at = Number(entry.at);
  if (!Number.isFinite(at) || at < now - LABEL_HISTORY_RETENTION_MS) return null;
  if (typeof entry.storyId !== 'string') return null;
  const correction = entry.field === 'correction';
  if (correction) {
    if (entry.trigger !== 'report' || typeof entry.reason !== 'string' || entry.reason === '') return null;
  } else if (entry.storyId === '' || !isLabelHistoryState(entry.previous) || !isLabelHistoryState(entry.next)) {
    return null;
  }
  const previousPublishers = Number(entry.previousPublishers);
  const nextPublishers = Number(entry.nextPublishers);
  if (!Number.isInteger(previousPublishers) || !Number.isInteger(nextPublishers)) return null;
  const score = Number(entry.credibilityScore);
  return {
    storyId: entry.storyId,
    field: correction ? 'correction' : 'corroboration',
    previous: correction ? '' : (entry.previous as LabelHistoryState),
    next: correction ? '' : (entry.next as LabelHistoryState),
    previousPublishers,
    nextPublishers,
    at,
    trigger: entry.trigger === 'report' ? 'report' : 'digest',
    reason: typeof entry.reason === 'string' ? entry.reason : '',
    sources: Array.isArray(entry.sources)
      ? entry.sources.map(asPublisher).filter((p): p is LabelChangePublisher => p !== null)
      : [],
    title: typeof entry.title === 'string' ? entry.title : '',
    link: typeof entry.link === 'string' ? entry.link : '',
    credibilityScore: entry.credibilityScore !== null && Number.isFinite(score) ? score : null,
  };
}
