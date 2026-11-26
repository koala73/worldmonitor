// Daily miss audit (#10976). Groups a day of queued rss_alert rows from
// shadow:score-log:v5 into stories and reads, from each row's `outcome`, what
// the relay decided for it: how many realtime rules matched and the branch
// that ended each one (scripts/notification-relay.cjs deliverToRules). Names
// the critical stories an edition missed, apart from the ones the relay
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

// The relay's per-rule counts (notification-relay.cjs deliverToRules), in its
// evaluation order. `matched` is the total the others share.
const BUCKETS = ['matched', 'freeSeverity', 'freeEventType', 'freeScope', 'repeat', 'quietHours', 'dedup', 'held', 'holdFailed', 'channelsRequeued', 'channelsFailed', 'noChannelListed', 'noChannelVerified', 'sendFailed', 'sent'];
// Rules that should have delivered and did not, and stops that lost the event.
// A failure the relay put back on the queue (channelsRequeued,
// stopped=rules_requeued) is neither: the retried copy logs its own row.
// `pending` is the row the relay writes at dequeue; one still pending never got
// its outcome, because the relay stopped mid-delivery or the final write failed.
const FAILED_BUCKETS = ['channelsFailed', 'sendFailed', 'holdFailed'];
const FAILED_STOPS = new Set(['error', 'rules_unavailable', 'pending']);
const STOP_LABELS = { pending: 'interrupted (no outcome recorded)' };
const MISS_BUCKETS = ['freeSeverity', 'freeEventType', 'freeScope', 'dedup', 'channelsRequeued', ...FAILED_BUCKETS];

/** One edition's recorded outcomes summed. */
function tallyOutcomes(rows) {
  const tally = { stopped: new Set(), noRule: {}, repeatOf: null };
  for (const { outcome } of rows) {
    for (const bucket of BUCKETS) if (outcome[bucket]) tally[bucket] = (tally[bucket] ?? 0) + outcome[bucket];
    if (outcome.stopped) tally.stopped.add(outcome.stopped);
    for (const [gate, n] of Object.entries(outcome.noRule ?? {})) tally.noRule[gate] = (tally.noRule[gate] ?? 0) + n;
    tally.repeatOf ??= outcome.repeatOf ?? null;
  }
  return tally;
}

const count = (tally, bucket) => tally[bucket] ?? 0;
const noChannel = (tally) => count(tally, 'noChannelListed') + count(tally, 'noChannelVerified');
const failed = (tally) => FAILED_BUCKETS.some((bucket) => count(tally, bucket) > 0) || [...tally.stopped].some((stop) => FAILED_STOPS.has(stop));
const formatCounts = (tally) => BUCKETS.filter((bucket) => count(tally, bucket) > 0).map((bucket) => `${bucket}=${count(tally, bucket)}`).join(', ');

function missGate(rows, tally) {
  const best = Math.max(...rows.filter((r) => r.severity === 'critical').map((r) => Number(r.importanceScore) || 0));
  if (best < REALTIME_CRITICAL_SCORE && !failed(tally)) return `score_bar (best ${best} < ${REALTIME_CRITICAL_SCORE})`;
  const parts = [
    ...[...tally.stopped].map((stop) => `stopped=${STOP_LABELS[stop] ?? stop}`),
    ...(Object.keys(tally.noRule).length ? [`no rule matched (${Object.entries(tally.noRule).map(([gate, n]) => `${gate}=${n}`).join(', ')})`] : []),
    ...MISS_BUCKETS.filter((bucket) => count(tally, bucket) > 0).map((bucket) => `${bucket}=${count(tally, bucket)}`),
  ];
  return parts.join(', ') || 'unknown';
}

// Where one edition's copies of a critical story stopped. First match wins:
// any rule that should have delivered and did not makes it a miss, even when
// other rules delivered; otherwise users who had the story already or are in
// quiet hours were not missed, and rules with no usable channel are a config
// gap. With no match it is a miss, or unknown while the edition has rows from
// before the relay recorded outcomes, since one of those may have delivered.
const VERDICTS = [
  ['missed', failed],
  ['delivered', (tally) => count(tally, 'sent') + count(tally, 'held') > 0],
  ['repeat', (tally) => count(tally, 'repeat') > 0],
  ['noChannel', (tally) => noChannel(tally) > 0],
  ['quietHours', (tally) => count(tally, 'quietHours') > 0],
];
const DETAILS = {
  missed: (tally, rows) => ({ gate: missGate(rows, tally) }),
  repeat: (tally) => ({ repeatOf: tally.repeatOf, skippedUsers: tally.repeat }),
  noChannel: (tally) => ({ rules: noChannel(tally), listedNone: count(tally, 'noChannelListed') }),
  quietHours: (tally) => ({ users: tally.quietHours }),
};

/**
 * @param {{ queued: Array<{ts:number,title:string,source:string,severity:string,importanceScore:number,variant?:string,publishedAt?:number|null,outcome?:object}>,
 *           sent: Array<{title:string,sentAt:number}> }} input
 *   `sent` (delivery receipts) only times stories against the wires.
 * @returns Critical stories, once per edition that did not deliver them:
 *   `missed` lists every edition where a rule failed to deliver or the event
 *   was lost or interrupted, whatever the other editions did. The other
 *   verdicts are listed only when no edition delivered the story: `missed`
 *   for an edition with nothing to explain it, `repeat`, `quietHours`, and
 *   `notRecorded` (the edition has rows logged before the relay recorded
 *   outcomes and the recorded rows explain nothing). An edition whose rules
 *   have no usable channel is also under `noChannel`, even when another
 *   edition delivered the story.
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
    const delivered = storyQueued.some((r) => count(r.outcome ?? {}, 'sent') + count(r.outcome ?? {}, 'held') > 0);
    for (const [edition, editionRows] of Map.groupBy(storyQueued, (r) => r.variant || 'none')) {
      if (!editionRows.some((r) => r.severity === 'critical')) continue;
      const first = editionRows.reduce((a, b) => (a.ts <= b.ts ? a : b));
      const entry = {
        title: first.title,
        edition,
        firstQueuedAt: first.ts,
        sources: [...new Set(editionRows.map((r) => r.source))],
        bestScore: Math.max(...editionRows.map((r) => Number(r.importanceScore) || 0)),
      };
      const recorded = editionRows.filter((r) => r.outcome && typeof r.outcome === 'object');
      const tally = tallyOutcomes(recorded);
      const verdict = VERDICTS.find(([, applies]) => applies(tally))?.[0] ?? (recorded.length < editionRows.length ? 'notRecorded' : 'missed');
      if (verdict === 'delivered') continue;
      const lists = new Set(delivered && !failed(tally) ? [] : [verdict]);
      if (noChannel(tally) > 0) lists.add('noChannel');
      for (const list of lists) result[list].push({ ...entry, counts: formatCounts(tally), ...DETAILS[list]?.(tally, editionRows) });
    }
  }
  return { ...result, wireStories, deliveredBeforeWire: beforeWire };
}
