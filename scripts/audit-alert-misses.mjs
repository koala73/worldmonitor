#!/usr/bin/env node
/**
 * Critical news stories an edition's realtime subscribers did not get. Read-only.
 *
 *   node scripts/audit-alert-misses.mjs                    # last 24 hours
 *   node scripts/audit-alert-misses.mjs --date 2026-11-18  # one UTC day (score log keeps 7 days)
 *
 * Reads shadow:score-log:v5 (every rss_alert the relay dequeued, with the
 * outcome the relay recorded for it), groups headlines into stories, and
 * prints each critical story an edition missed with the gate that stopped it:
 * a failed send, hold or channel read, or an event the relay never finished,
 * even when another edition delivered the story. Reworded repeats the relay skipped, editions with no usable
 * channel and quiet-hours holds are listed apart from misses. The
 * wm:notif:sent:v1:<userId> receipts only time stories against the wires.
 * See scripts/lib/alert-miss-audit.mjs.
 */
import { loadEnvFile } from './_env-file.mjs';
import { BREAKING_WIRES, auditMisses } from './lib/alert-miss-audit.mjs';

const SCORE_LOG_KEY = 'shadow:score-log:v5';
const SENT_PREFIX = 'wm:notif:sent:v1:';
const DAY_MS = 24 * 60 * 60 * 1000;
// Rows queued this recently may still be on their way to subscribers.
const SETTLE_MS = 15 * 60 * 1000;

const SECTIONS = [
  ['missed', 'Critical stories an edition failed to deliver', (s) => `gate=${s.gate}`],
  ['noChannel', 'Config gap: no usable channel on the edition\'s matching rules', (s) => `rules=${s.rules} (${s.listedNone} list no channel)`],
  ['repeat', 'Not misses: reworded repeats of an alert subscribers already had', (s) => `skipped=${s.skippedUsers} repeat_of="${s.repeatOf?.title ?? 'unknown'}"`],
  ['quietHours', 'Not misses: silenced by quiet hours', (s) => `users=${s.users}`],
  ['notRecorded', 'Unknown: delivery may sit on rows queued before the relay recorded outcomes', null],
];

// The score log keeps 7 days; an older day would print an empty report.
const RETENTION_DAYS = 7;

function parseWindow(argv) {
  if (argv.length === 0) return { from: Date.now() - SETTLE_MS - DAY_MS, to: Date.now() - SETTLE_MS };
  const date = argv.length === 1 && argv[0].startsWith('--date=') ? argv[0].slice(7) : argv.length === 2 && argv[0] === '--date' ? argv[1] : null;
  if (date === null) throw new Error('usage: audit-alert-misses.mjs [--date YYYY-MM-DD]');
  const from = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(from) || new Date(from).toISOString().slice(0, 10) !== date) {
    throw new Error('--date needs a real YYYY-MM-DD day');
  }
  if (from < Date.now() - RETENTION_DAYS * DAY_MS) throw new Error(`--date ${date} is older than the score log's ${RETENTION_DAYS}-day retention`);
  if (from + DAY_MS > Date.now() - SETTLE_MS) throw new Error(`--date ${date} has not finished yet; omit --date for the last 24 hours`);
  return { from, to: from + DAY_MS };
}

async function redis(url, token, commands) {
  const res = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'worldmonitor-alert-miss-audit/1.0' },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Redis pipeline: HTTP ${res.status}`);
  return (await res.json()).map((row) => {
    if (row?.error) throw new Error(row.error);
    return row.result;
  });
}

const parseRows = (members) => (members ?? []).flatMap((m) => {
  try { return [JSON.parse(m)]; } catch { return []; }
});

async function sentKeys(url, token) {
  const keys = new Set();
  let cursor = '0';
  do {
    const [[next, batch]] = await redis(url, token, [['SCAN', cursor, 'MATCH', `${SENT_PREFIX}*`, 'COUNT', '1000']]);
    cursor = next;
    for (const key of batch) keys.add(key);
  } while (cursor !== '0');
  return [...keys];
}

async function main() {
  const { from, to } = parseWindow(process.argv.slice(2));
  loadEnvFile(import.meta.url);
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');

  const [scoreMembers] = await redis(url, token, [['ZRANGEBYSCORE', SCORE_LOG_KEY, String(from), `(${to}`]]);
  const queued = parseRows(scoreMembers);
  const keys = await sentKeys(url, token);
  const sent = [];
  for (let i = 0; i < keys.length; i += 200) {
    const lists = await redis(url, token, keys.slice(i, i + 200).map((key) => ['LRANGE', key, '0', '-1']));
    for (const list of lists) sent.push(...parseRows(list).filter((r) => (r.eventType === undefined || r.eventType === 'rss_alert') && r.sentAt >= from - DAY_MS && r.sentAt < to + DAY_MS));
  }

  const audit = auditMisses({ queued, sent });
  console.log(`${new Date(from).toISOString()} to ${new Date(to).toISOString()}: ${queued.length} queued rows, ${sent.length} delivered records from ${keys.length} users`);
  for (const [verdict, heading, describe] of SECTIONS) {
    console.log(`\n${heading}: ${audit[verdict].length}`);
    for (const story of describe ? audit[verdict] : []) {
      console.log(`  ${new Date(story.firstQueuedAt).toISOString()}  [${story.edition}]  ${story.title}`);
      console.log(`    ${describe(story)}  rules: ${story.counts}  best=${story.bestScore}  sources=${story.sources.join(', ')}`);
    }
  }
  const { wireStories, deliveredBeforeWire } = audit;
  console.log(`\nAhead of the wires (${BREAKING_WIRES.join(', ')}): ${deliveredBeforeWire} of ${wireStories} wire-covered stories reached subscribers before the first wire copy`);
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
