// Daily miss audit (#10976). Groups a day of queued rss_alert rows from
// shadow:score-log:v5 into stories, joins them to what the relay delivered
// (wm:notif:sent:v1:<userId>), and names the critical stories that reached
// nobody. Pure: scripts/audit-alert-misses.mjs does the Redis reads.
import { extractTitleWords, jaccardSimilarity } from './brief-dedup-jaccard.mjs';

export const REALTIME_CRITICAL_SCORE = 82;
// Two wordings of one development share most content words once each word is
// cut to its first five letters (attacked/attack, vessels/vessel).
export const STORY_MATCH_MIN = 0.4;
export const BREAKING_WIRES = ['Reuters', 'AP News', 'Associated Press', 'AFP', 'Bloomberg', 'BBC World'];

const stems = (title) => new Set([...extractTitleWords(title)].map((word) => word.slice(0, 5)));
const isWire = (source) => BREAKING_WIRES.some((wire) => String(source ?? '').toLowerCase().startsWith(wire.toLowerCase()));

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

function missGate(queued) {
  const critical = queued.filter((r) => r.severity === 'critical');
  const best = Math.max(...critical.map((r) => Number(r.importanceScore) || 0));
  if (best < REALTIME_CRITICAL_SCORE) return `score_bar (best ${best} < ${REALTIME_CRITICAL_SCORE})`;
  return 'rule_match_or_delivery (see the relay "No rule matched" and delivery lines)';
}

/**
 * @param {{ queued: Array<{ts:number,title:string,source:string,severity:string,importanceScore:number,publishedAt?:number|null}>,
 *           sent: Array<{title:string,sentAt:number}> }} input
 */
export function auditMisses({ queued, sent }) {
  const rows = [
    ...queued.filter((r) => r.eventType === undefined || r.eventType === 'rss_alert').map((r) => ({ ...r, kind: 'queued' })),
    ...sent.map((r) => ({ ...r, kind: 'sent' })),
  ];
  const missed = [];
  let wireStories = 0;
  let beforeWire = 0;
  for (const story of groupStories(rows)) {
    const storyQueued = story.filter((r) => r.kind === 'queued');
    if (storyQueued.length === 0) continue;
    const sentAts = story.filter((r) => r.kind === 'sent').map((r) => r.sentAt);
    const wireAts = storyQueued.filter((r) => isWire(r.source)).map((r) => r.publishedAt || r.ts);
    if (wireAts.length > 0) {
      wireStories++;
      if (sentAts.length > 0 && Math.min(...sentAts) < Math.min(...wireAts)) beforeWire++;
    }
    if (sentAts.length > 0 || !storyQueued.some((r) => r.severity === 'critical')) continue;
    const first = storyQueued.reduce((a, b) => (a.ts <= b.ts ? a : b));
    missed.push({
      title: first.title,
      firstQueuedAt: first.ts,
      sources: [...new Set(storyQueued.map((r) => r.source))],
      bestScore: Math.max(...storyQueued.map((r) => Number(r.importanceScore) || 0)),
      gate: missGate(storyQueued),
    });
  }
  return { missed, wireStories, deliveredBeforeWire: beforeWire };
}
