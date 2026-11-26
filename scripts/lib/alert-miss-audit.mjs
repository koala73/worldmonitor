// Daily miss audit (#10976). Groups a day of queued rss_alert rows from
// shadow:score-log:v5 into stories and reads, from each row's `outcome`, what
// the relay decided for it: how many realtime rules matched and the branch
// that ended each one (scripts/notification-relay.cjs deliverToRules). Names
// the critical stories that reached nobody, apart from the ones the relay
// skipped on purpose. Pure: scripts/audit-alert-misses.mjs does the Redis reads.
import { extractTitleWords, jaccardSimilarity } from './brief-dedup-jaccard.mjs';

export const REALTIME_CRITICAL_SCORE = 82;
// Two wordings of one development share most content words once each word is
// cut to its first five letters (attacked/attack, vessels/vessel).
export const STORY_MATCH_MIN = 0.4;
export const BREAKING_WIRES = ['Reuters', 'AP News', 'Associated Press', 'AFP', 'Bloomberg', 'BBC World', 'BBC News'];

const stems = (title) => new Set([...extractTitleWords(title)].map((word) => word.slice(0, 5)));
const namesWire = (text) => BREAKING_WIRES.some((wire) => text.toLowerCase().startsWith(wire.toLowerCase()));
// Topic feeds carry the publisher only as a title suffix: "... - Reuters".
const isWire = (row) => namesWire(String(row.source ?? '')) || namesWire(String(row.title ?? '').match(/\s[-–—|]\s*([^-–—|]+)$/u)?.[1] ?? '');

/** Single-link clusters of rows whose headlines match. Each row: { title, ... }. */
export function groupStories(rows) {
  let stories = [];
  for (const row of rows) {
    const words = stems(row.title ?? '');
    const linked = stories.filter((s) => s.words.some((w) => jaccardSimilarity(w, words) >= STORY_MATCH_MIN));
    const merged = { rows: [...linked.flatMap((s) => s.rows), row], words: [...linked.flatMap((s) => s.words), words] };
    stories = [...stories.filter((s) => !linked.includes(s)), merged];
  }
  return stories.map((s) => s.rows);
}

// Rule counts a miss can name, in the relay's evaluation order.
const MISS_BUCKETS = ['freeSeverity', 'freeEventType', 'freeScope', 'dedup', 'channelsFailed', 'sendFailed'];

/** One edition's recorded outcomes summed. */
function tallyOutcomes(rows) {
  const tally = { stopped: new Set(), noRule: {}, repeatOf: null };
  for (const { outcome } of rows) {
    for (const [field, value] of Object.entries(outcome)) {
      if (typeof value === 'number') tally[field] = (tally[field] ?? 0) + value;
    }
    if (outcome.stopped) tally.stopped.add(outcome.stopped);
    for (const [gate, n] of Object.entries(outcome.noRule ?? {})) tally.noRule[gate] = (tally.noRule[gate] ?? 0) + n;
    tally.repeatOf ??= outcome.repeatOf ?? null;
  }
  return tally;
}

const count = (tally, field) => tally[field] ?? 0;
const noChannel = (tally) => count(tally, 'noChannelListed') + count(tally, 'noChannelVerified');

function missGate(rows, tally) {
  const best = Math.max(...rows.filter((r) => r.severity === 'critical').map((r) => Number(r.importanceScore) || 0));
  if (best < REALTIME_CRITICAL_SCORE) return `score_bar (best ${best} < ${REALTIME_CRITICAL_SCORE})`;
  const parts = [
    ...[...tally.stopped].map((stop) => `stopped=${stop}`),
    ...(Object.keys(tally.noRule).length ? [`no rule matched (${Object.entries(tally.noRule).map(([gate, n]) => `${gate}=${n}`).join(', ')})`] : []),
    ...MISS_BUCKETS.filter((bucket) => count(tally, bucket) > 0).map((bucket) => `${bucket}=${count(tally, bucket)}`),
  ];
  return parts.join(', ') || 'unknown';
}

// Where one edition's copies of a critical story stopped. First match wins:
// a user who had the story already, or will get it after quiet hours, was not
// missed, and an edition with no usable channel is a config gap.
const VERDICTS = [
  ['delivered', (tally) => count(tally, 'sent') + count(tally, 'held') > 0, () => ({})],
  ['repeat', (tally) => count(tally, 'repeat') > 0, (tally) => ({ repeatOf: tally.repeatOf, skippedUsers: tally.repeat })],
  ['noChannel', (tally) => noChannel(tally) > 0, (tally) => ({ rules: noChannel(tally), listedNone: count(tally, 'noChannelListed') })],
  ['quietHours', (tally) => count(tally, 'quietHours') > 0, (tally) => ({ users: tally.quietHours })],
  ['missed', () => true, (tally, rows) => ({ gate: missGate(rows, tally) })],
];

/**
 * @param {{ queued: Array<{ts:number,title:string,source:string,severity:string,importanceScore:number,variant?:string,publishedAt?:number|null,outcome?:object}>,
 *           sent: Array<{title:string,sentAt:number}> }} input
 *   `sent` (delivery receipts) only times stories against the wires.
 * @returns Each critical story that reached nobody, once per edition, under
 *   `missed`, `repeat`, `noChannel`, `quietHours`, or `notRecorded` (rows
 *   logged before the relay recorded outcomes). An edition with no usable
 *   channel is listed even when another edition delivered the story.
 */
export function auditMisses({ queued, sent }) {
  const rows = [
    ...queued.filter((r) => r.eventType === undefined || r.eventType === 'rss_alert').map((r) => ({ ...r, kind: 'queued' })),
    ...sent.map((r) => ({ ...r, kind: 'sent' })),
  ];
  const result = { missed: [], repeat: [], noChannel: [], quietHours: [], notRecorded: [] };
  let wireStories = 0;
  let beforeWire = 0;
  for (const story of groupStories(rows)) {
    const storyQueued = story.filter((r) => r.kind === 'queued');
    if (storyQueued.length === 0) continue;
    const sentAts = story.filter((r) => r.kind === 'sent').map((r) => r.sentAt);
    const wireAts = storyQueued.filter(isWire).map((r) => r.publishedAt || r.ts);
    if (wireAts.length > 0) {
      wireStories++;
      if (sentAts.length > 0 && Math.min(...sentAts) < Math.min(...wireAts)) beforeWire++;
    }
    if (!storyQueued.some((r) => r.severity === 'critical')) continue;
    const editions = Map.groupBy(storyQueued, (r) => r.variant || 'none');
    const verdicts = [...editions].filter(([, editionRows]) => editionRows.some((r) => r.severity === 'critical')).map(([edition, editionRows]) => {
      const recorded = editionRows.filter((r) => r.outcome && typeof r.outcome === 'object');
      if (recorded.length === 0) return { edition, editionRows, verdict: 'notRecorded', detail: {} };
      const tally = tallyOutcomes(recorded);
      const [verdict, , detail] = VERDICTS.find(([, applies]) => applies(tally));
      return { edition, editionRows, verdict, detail: detail(tally, editionRows) };
    });
    const delivered = storyQueued.some((r) => count(r.outcome ?? {}, 'sent') + count(r.outcome ?? {}, 'held') > 0);
    for (const { edition, editionRows, verdict, detail } of verdicts) {
      if (verdict === 'delivered' || (delivered && verdict !== 'noChannel')) continue;
      const first = editionRows.reduce((a, b) => (a.ts <= b.ts ? a : b));
      result[verdict].push({
        title: first.title,
        edition,
        firstQueuedAt: first.ts,
        sources: [...new Set(editionRows.map((r) => r.source))],
        bestScore: Math.max(...editionRows.map((r) => Number(r.importanceScore) || 0)),
        ...detail,
      });
    }
  }
  return { ...result, wireStories, deliveredBeforeWire: beforeWire };
}
