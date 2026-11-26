// Replays one recorded alert incident (tests/fixtures/alert-replays.json)
// through the code production runs, wording by wording in the order the relay
// queued them, so publisher coverage and cross-wording sightings accumulate
// from the earlier wordings:
//
//   digest: recordPublisherCoverage, toProtoItem (list-feed-digest.ts)
//   relay:  buildClassifyCandidateMap (digest-stale-gate.cjs), then, run from
//           the source of scripts/ais-relay.cjs, readObservedPublishers,
//           crossWordingFamilies, publishAlert and relayComputeImportanceScore
//   corroboration: recordSightings and crossWordingFamilies (news-corroboration.mjs)
//   notification relay: ruleDropReason (notification-relay.cjs)
//
// Seams: one in-memory sorted-set store stands in for Upstash (the digest's
// coverage write through fetch, the relay's upstashPipeline, the corroboration
// module's pipeline), Date.now is the wording's queue time, and the caller
// supplies the embedder and the "same incident?" judge. publishNotificationEvent
// captures the event instead of queueing it.
import { readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// Every Redis client in this process must miss production, whatever the shell exports.
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'replay';
process.env.VERCEL_ENV = 'production';
process.env.CONVEX_URL ??= 'https://stub.convex.cloud';
process.env.CONVEX_NOTIFICATION_RELAY_SECRET ??= 'stub-secret';
process.env.IMPORTANCE_SCORE_LIVE = '1';

const { toProtoItem, __testing__: digest } = await import('../../server/worldmonitor/news/v1/list-feed-digest.ts');
const corroboration = await import('../../scripts/lib/news-corroboration.mjs');
const { normalizeForEmbedding } = await import('../../scripts/lib/brief-embedding.mjs');

const relayPath = fileURLToPath(new URL('../../scripts/ais-relay.cjs', import.meta.url));
const relayRequire = createRequire(relayPath);
const relaySource = readFileSync(relayPath, 'utf8');

const ModuleWithLoad = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const originalLoad = ModuleWithLoad._load;
ModuleWithLoad._load = function patchedLoad(this: unknown, request: string, ...rest: unknown[]) {
  if (request === 'resend') return { Resend: class {} };
  if (request === 'convex/browser') return { ConvexHttpClient: class { async query() {} } };
  return originalLoad.call(this, request, ...rest);
};
const { ruleDropReason } = relayRequire('./notification-relay.cjs');
ModuleWithLoad._load = originalLoad;
const { buildClassifyCandidateMap } = relayRequire('./lib/digest-stale-gate.cjs');
const storyKey = relayRequire('./lib/news-story-key.cjs');
const NEWS_CATALOG = relayRequire('../shared/news-catalog.json');

export type Label = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type Reach = 'realtime' | 'local' | 'none';

export interface Wording {
  title: string;
  source: string;
  originPublisher?: string;
  link?: string;
  label: Label;
  variant: string;
  publishedAt: string;
  firstSeen?: string;
  seenAt: string;
  corroboration: number;
  observedScore: number;
  /** What the logged inputs score today when a tier-table fix moved it, with the reason. */
  loggedInputsScoreNow?: number;
  loggedInputsScoreNowBecause?: string;
  scoreNow: number;
  reaches: Reach;
  corroboratedBy?: string[];
}

export interface Match { candidate: string; earlier: string; similarity: number; same?: boolean }

export interface Incident {
  id: string;
  expected: 'alert' | 'none';
  knownMiss?: string;
  wordings: Wording[];
  matches?: Match[];
}

export interface Replayed {
  wording: Wording;
  /** relayComputeImportanceScore on the inputs the score log recorded. */
  loggedInputsScore: number;
  published: boolean;
  score: number | null;
  /** Publisher families the coverage history held for the headline. */
  observedFamilies: string[];
  /** Families the cross-wording check counted, the wording's own included (payload.corroboratedBy). */
  corroboratedBy: string[];
  reaches: Reach;
  dropReason: string | null;
}

export type Embed = (texts: string[]) => Promise<number[][]>;
export type Judge = (systemPrompt: string, userPrompt: string) => Promise<string>;

// Upstash's sorted-set commands as the replayed code uses them.
export class SortedSets {
  private sets = new Map<string, Map<string, number>>();

  private range(key: string, min: string, max: string) {
    const bound = (raw: string, low: boolean) => {
      if (raw === '-inf') return { value: -Infinity, open: false };
      if (raw === '+inf') return { value: Infinity, open: false };
      const open = raw.startsWith('(');
      const value = Number(open ? raw.slice(1) : raw);
      if (!Number.isFinite(value)) throw new Error(`bad ${low ? 'min' : 'max'} ${raw}`);
      return { value, open };
    };
    const lo = bound(String(min), true);
    const hi = bound(String(max), false);
    return [...(this.sets.get(key) ?? new Map())]
      .filter(([, s]) => (lo.open ? s > lo.value : s >= lo.value) && (hi.open ? s < hi.value : s <= hi.value))
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  }

  run(command: unknown[]): unknown {
    const [verb, key, ...args] = command.map(String) as [string, string, ...string[]];
    switch (verb.toUpperCase()) {
      case 'MULTI': case 'EXEC': return 'OK';
      case 'EXPIRE': return 1;
      case 'ZADD': {
        const gt = args[0] === 'GT';
        const pairs = gt ? args.slice(1) : args;
        const set = this.sets.get(key) ?? new Map<string, number>();
        this.sets.set(key, set);
        let added = 0;
        for (let i = 0; i + 1 < pairs.length; i += 2) {
          const score = Number(pairs[i]);
          const member = pairs[i + 1]!;
          const prior = set.get(member);
          if (prior === undefined) added++;
          if (prior === undefined || !gt || score > prior) set.set(member, score);
        }
        return added;
      }
      case 'ZRANGEBYSCORE': {
        const rows = this.range(key, args[0]!, args[1]!);
        return args.includes('WITHSCORES') ? rows.flatMap(([m, s]) => [m, String(s)]) : rows.map(([m]) => m);
      }
      case 'ZREMRANGEBYSCORE': {
        const rows = this.range(key, args[0]!, args[1]!);
        for (const [m] of rows) this.sets.get(key)!.delete(m);
        return rows.length;
      }
      case 'ZREMRANGEBYRANK': {
        const rows = this.range(key, '-inf', '+inf');
        // Redis ranks: a negative index counts from the end, and a stop that
        // lands before the start (e.g. 0 -1001 on 501 members) removes nothing.
        const at = (i: number) => (i < 0 ? rows.length + i : i);
        const start = Math.max(0, at(Number(args[0])));
        const stop = Math.min(rows.length - 1, at(Number(args[1])));
        const doomed = stop < start ? [] : rows.slice(start, stop + 1);
        for (const [m] of doomed) this.sets.get(key)!.delete(m);
        return doomed.length;
      }
      default: throw new Error(`replay store has no ${verb}`);
    }
  }

  pipeline = async (commands: unknown[][]) => commands.map((command) => ({ result: this.run(command) }));
}

function relaySlice(from: string, to: string): string {
  const start = relaySource.indexOf(from);
  const end = start < 0 ? -1 : relaySource.indexOf(to, start);
  if (start < 0 || end < 0) {
    throw new Error(`scripts/ais-relay.cjs no longer has the replayed code from ${JSON.stringify(from)} to ${JSON.stringify(to)}`);
  }
  return relaySource.slice(start, end);
}

const SCORING = relaySlice('const RELAY_SOURCE_TIERS = {', '\nconst CLASSIFY_VALID_LEVELS');
const COUNTRIES = relaySlice('const THREAT_COUNTRY_NAME_TO_ISO2 = {', '\nfunction classifyCacheKey(');
const CROSS_WORDING = relaySlice('const CROSS_WORDING_MAX_CHECKS', '\nasync function seedClassifyForVariant(');
const PUBLISH_ALERT = relaySlice('  const publishAlert = (', '\n  const parsedRows');

function loadRelay(store: SortedSets, bound: { recordSightings: unknown; crossWordingFamilies: unknown }) {
  const published: Array<Record<string, any>> = [];
  const context = vm.createContext({
    require: relayRequire,
    requireShared: (name: string) => relayRequire(`../shared/${name}`),
    SAUDI_CIVIL_DEFENSE: relayRequire('./lib/saudi-civil-defense-alerts.cjs').SAUDI_CIVIL_DEFENSE,
    notifyPolicy: relayRequire('./lib/notification-publish-policy.cjs'),
    alertLatency: relayRequire('./lib/classify-digest-request.cjs').alertLatency,
    ...storyKey,
    upstashPipeline: store.pipeline,
    newsCorroborationPromise: Promise.resolve(bound),
    // Off in production on 2026-11-18: the relay queued the Gulf News copy
    // 13,241 s after publication, which the 15-minute gate would have dropped.
    RELAY_GATES_READY: false,
    RELAY_RECENCY_MS: 15 * 60 * 1000,
    recordAlertLatency: () => {},
    publishNotificationEvent: async (event: Record<string, any>) => { published.push(event); },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    Date, setTimeout, clearTimeout,
  });
  for (const code of [SCORING, COUNTRIES, CROSS_WORDING]) vm.runInContext(code, context);
  const makePublishAlert = vm.runInContext(
    `(function (allTitles, variant, classifyNow, poolBacklogUntil, poolBacklog, classifyKeyFor, alertGateDrops, digestBuildAt) {\n${PUBLISH_ALERT}\nreturn publishAlert;\n})`,
    context,
  );
  return {
    published,
    relayComputeImportanceScore: vm.runInContext('relayComputeImportanceScore', context),
    readObservedPublishers: vm.runInContext('readObservedPublishers', context),
    crossWordingFamilies: vm.runInContext('crossWordingFamilies', context),
    newClassifyCycle: () => vm.runInContext('crossWordingChecksLeft = CROSS_WORDING_MAX_CHECKS', context),
    publishAlert: (allTitles: Map<string, unknown>, variant: string, at: number) =>
      makePublishAlert(allTitles, variant, at, 0, null, (t: string) => t, { tier4: 0, recency: 0 }, at),
  };
}

const trustedFeedNames = new Set<string>(
  NEWS_CATALOG.feeds.filter((feed: { url: string }) => digest.isTrustedOriginAggregator(feed.url)).map((feed: { name: string }) => feed.name),
);

// The item parseRssXml would have produced: a trusted aggregator's <source>
// element is the only origin the digest accepts.
function parsedItem(w: Wording) {
  return {
    source: w.source,
    originPublisher: w.originPublisher ?? '',
    originPublisherTrusted: trustedFeedNames.has(w.source),
    title: w.title,
    link: w.link ?? '',
    publishedAt: Date.parse(w.publishedAt),
    isAlert: false,
    level: w.label,
    category: 'conflict',
    confidence: 0.9,
    classSource: 'llm' as const,
    importanceScore: 0,
    credibilityScore: 0,
    corroborationCount: w.corroboration,
    entityCorroborationCount: 0,
    lang: 'en',
    description: '',
    isOpinion: false,
    isFeelGood: false,
    isEphemeralLiveCoverage: false,
  };
}

/** Titles are compared as the embedder sees them, so a prompt or embed input maps back to its wording. */
export const sameTitle = (a: string, b: string) => normalizeForEmbedding(a) === normalizeForEmbedding(b);

/**
 * The embedder and judge answering from the incident's recorded matches. The
 * embedder returns vectors whose cosine to the candidate is the recorded
 * similarity, so the retrieval floor and the shortlist cut still run. A
 * question with no record is listed in `missing` and fails that check.
 */
export function recordedMatcher(incident: Incident) {
  const missing: string[] = [];
  const find = (candidate: string, earlier: string) =>
    incident.matches?.find((m) => sameTitle(m.candidate, candidate) && sameTitle(m.earlier, earlier));
  const embed: Embed = async (texts) => {
    const vectors: number[][] = [texts.map((_, i) => (i === 0 ? 1 : 0))];
    texts.slice(1).forEach((text, i) => {
      const similarity = find(texts[0]!, text)?.similarity;
      if (similarity === undefined) {
        missing.push(`similarity of ${JSON.stringify(texts[0])} to ${JSON.stringify(text)}`);
        throw new Error('no recorded similarity');
      }
      vectors.push(texts.map((_, j) => (j === 0 ? similarity : j === i + 1 ? Math.sqrt(1 - similarity ** 2) : 0)));
    });
    return vectors;
  };
  const judge: Judge = async (systemPrompt, userPrompt) => {
    const pair = /^Headline A: (.*)\nHeadline B, seen \d+h earlier: (.*)$/.exec(userPrompt);
    const same = pair && systemPrompt === corroboration.JUDGE_SYSTEM_PROMPT ? find(pair[1]!, pair[2]!)?.same : undefined;
    if (typeof same !== 'boolean') {
      missing.push(`verdict for ${JSON.stringify(userPrompt)}`);
      return 'no recorded verdict';
    }
    return JSON.stringify({ same });
  };
  return { embed, judge, missing };
}

// Every alert rule belongs to one edition (alertRules.variant), so the replay
// asks about a realtime subscriber of the edition the event was published in.
function reachOf(event: Record<string, any>): { reaches: Reach; dropReason: string | null } {
  const rule = { variant: event.variant, sensitivity: 'critical', digestMode: 'realtime', eventTypes: [] };
  const dropReason = ruleDropReason(rule, event);
  if (dropReason === null) return { reaches: 'realtime', dropReason };
  const country = event.payload?.primaryCountryCode;
  if (country && ruleDropReason({ ...rule, countries: [country] }, event) === null) return { reaches: 'local', dropReason };
  return { reaches: 'none', dropReason };
}

/**
 * `deadlineMs` overrides the production check deadline, for a recording run
 * against the real models. `log` receives the corroboration module's lines.
 */
export async function replayIncident(
  incident: Incident,
  { embed, judge, deadlineMs, log = () => {} }: { embed: Embed; judge: Judge; deadlineMs?: number; log?: (line: string) => void },
): Promise<Replayed[]> {
  const store = new SortedSets();
  const bound = {
    recordSightings: (sightings: unknown, opts = {}) => corroboration.recordSightings(sightings, { ...opts, pipeline: store.pipeline, log }),
    crossWordingFamilies: (candidates: unknown, opts = {}) => corroboration.crossWordingFamilies(candidates, {
      ...opts, ...(deadlineMs ? { deadlineMs } : {}), pipeline: store.pipeline, embed, judge, log,
    }),
  };
  const relay = loadRelay(store, bound);
  const ordered = [...incident.wordings].sort((a, b) => Date.parse(a.seenAt) - Date.parse(b.seenAt));
  const built: ReturnType<typeof parsedItem>[] = [];
  const results: Replayed[] = [];
  for (const wording of ordered) {
    const at = Date.parse(wording.seenAt);
    const clock = mock.method(Date, 'now', () => at);
    const fetchMock = mock.method(globalThis, 'fetch', async (url: unknown, init?: { body?: string }) => {
      if (!String(url).startsWith('https://redis.invalid/')) throw new Error(`replay made a network call: ${String(url)}`);
      return Response.json(await store.pipeline(JSON.parse(init?.body ?? '[]')));
    });
    try {
      const item = parsedItem(wording);
      built.push(item);
      // The digest build that served this copy also saw every earlier wording.
      await digest.recordPublisherCoverage(built, [item], at, Infinity);
      fetchMock.mock.restore();
      const firstSeen = wording.firstSeen ? Date.parse(wording.firstSeen) : 0;
      const served = toProtoItem(item as never, firstSeen ? { firstSeen, mentionCount: 1, sourceCount: 1, phase: 'STORY_PHASE_BREAKING' } as never : undefined);
      const allTitles = buildClassifyCandidateMap({ categories: { replay: { items: [served] } } }, [], wording.variant, at, 6 * 3_600_000, undefined, []);
      const loggedInputsScore = relay.relayComputeImportanceScore(wording.label, wording.source, wording.corroboration, Date.parse(wording.publishedAt), {
        title: wording.title, classSource: 'llm', entityCorroborationCount: 0,
      });
      relay.newClassifyCycle();
      const observed = await relay.readObservedPublishers([wording.title]);
      const crossWording = await relay.crossWordingFamilies([wording.title], new Map([[0, wording.label]]), allTitles, observed);
      relay.published.length = 0;
      relay.publishAlert(allTitles, wording.variant, at)(wording.title, wording.label, 'conflict', {
        observed: observed.get(wording.title), crossWording: crossWording.get(wording.title),
      });
      const event = relay.published[0];
      results.push({
        wording,
        loggedInputsScore,
        published: Boolean(event),
        score: event?.payload.importanceScore ?? null,
        observedFamilies: [...(observed.get(wording.title) ?? [])],
        corroboratedBy: [...(event?.payload.corroboratedBy ?? [])],
        ...(event ? reachOf(event) : { reaches: 'none' as const, dropReason: 'unpublished' }),
      });
    } finally {
      fetchMock.mock.restore();
      clock.mock.restore();
    }
  }
  return results;
}
