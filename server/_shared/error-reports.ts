/**
 * Reader error reports (#9093). A reader says a label or story is wrong; the
 * report is stored for an operator and never applied automatically. Accepting
 * one publishes only the operator's public note to the label log; the
 * reader's message and contact stay private.
 *
 * Storage: one JSON record per report (90-day TTL), a pending queue and a
 * reviewed list as sorted sets. The pending queue is bounded: when it is full,
 * new reports are refused rather than evicting older ones, so spam can never
 * push a real report out unseen.
 */
import { runRedisPipeline, runRedisTransaction, type RedisCommandResult } from './redis';
import { correctionEntry, labelChangeCommands } from './label-history';
import { timingSafeEqual } from './internal-auth';

export const ERROR_REPORT_KEY = (id: string) => `trust:report:v1:${id}`;
export const PENDING_REPORTS_KEY = 'trust:reports:pending:v1';
export const REVIEWED_REPORTS_KEY = 'trust:reports:reviewed:v1';
export const PENDING_REPORTS_MAX = 1000;
const REVIEWED_REPORTS_MAX = 500;
const LIST_LIMIT = 200;
export const ERROR_REPORT_TTL_S = 90 * 24 * 60 * 60;
const ERROR_REPORT_TTL_MS = ERROR_REPORT_TTL_S * 1000;
const REVIEW_LOCK_KEY = (id: string) => `trust:report-review-lock:v1:${id}`;
/** A crashed review frees its report after this. */
const REVIEW_LOCK_TTL_S = 60;

export const TRUST_REVIEW_HEADER = 'x-trust-review-key';

export type ErrorReportStatus = 'pending' | 'accepted' | 'rejected';

export interface StoredErrorReport {
  id: string;
  status: ErrorReportStatus;
  message: string;
  storyId: string;
  url: string;
  contact: string;
  createdAt: number;
  reviewedAt: number;
  publicNote: string;
}

/** True only when TRUST_REVIEW_SECRET is set and the request carries it. Unset → nobody is an operator. */
export async function isTrustReviewer(request: Request): Promise<boolean> {
  const secret = process.env.TRUST_REVIEW_SECRET;
  if (!secret) return false;
  return timingSafeEqual(request.headers.get(TRUST_REVIEW_HEADER) ?? '', secret);
}

function parseReport(raw: unknown): StoredErrorReport | null {
  if (typeof raw !== 'string') return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredErrorReport>;
    if (typeof value.id !== 'string' || typeof value.message !== 'string') return null;
    if (value.status !== 'pending' && value.status !== 'accepted' && value.status !== 'rejected') return null;
    return {
      id: value.id,
      status: value.status,
      message: value.message,
      storyId: typeof value.storyId === 'string' ? value.storyId : '',
      url: typeof value.url === 'string' ? value.url : '',
      contact: typeof value.contact === 'string' ? value.contact : '',
      createdAt: Number(value.createdAt) || 0,
      reviewedAt: Number(value.reviewedAt) || 0,
      publicNote: typeof value.publicNote === 'string' ? value.publicNote : '',
    };
  } catch {
    return null;
  }
}

const confirmed = (results: RedisCommandResult[], count: number) =>
  results.length === count && results.every((result) => !result.error);

/**
 * 'received', 'queue-full', or 'unavailable' when Redis could not confirm the write.
 *
 * One transaction prunes ids whose records have expired, inserts the report
 * and counts the queue. A report that lands past the cap is taken back out, so
 * the queue never holds more than PENDING_REPORTS_MAX: two concurrent
 * submissions at 999 may both be refused, never both kept.
 */
export async function storeErrorReport(report: StoredErrorReport): Promise<'received' | 'queue-full' | 'unavailable'> {
  const commands = [
    ['ZREMRANGEBYSCORE', PENDING_REPORTS_KEY, '-inf', report.createdAt - ERROR_REPORT_TTL_MS],
    ['SET', ERROR_REPORT_KEY(report.id), JSON.stringify(report), 'NX', 'EX', ERROR_REPORT_TTL_S],
    ['ZADD', PENDING_REPORTS_KEY, report.createdAt, report.id],
    ['ZCARD', PENDING_REPORTS_KEY],
  ];
  const results = await runRedisTransaction(commands);
  if (!confirmed(results, commands.length)) return 'unavailable';
  if (Number(results[3]!.result) <= PENDING_REPORTS_MAX) return 'received';
  await runRedisPipeline([['ZREM', PENDING_REPORTS_KEY, report.id], ['DEL', ERROR_REPORT_KEY(report.id)]]);
  return 'queue-full';
}

/**
 * Pending reports oldest first, or reviewed reports newest first; null when
 * Redis is unreadable. Ids whose records have expired are pruned first, so
 * they cannot fill the page or the queue.
 */
export async function listErrorReports(status: 'pending' | 'reviewed', now = Date.now()): Promise<StoredErrorReport[] | null> {
  const key = status === 'pending' ? PENDING_REPORTS_KEY : REVIEWED_REPORTS_KEY;
  const results = await runRedisPipeline([
    ['ZREMRANGEBYSCORE', key, '-inf', now - ERROR_REPORT_TTL_MS],
    status === 'pending' ? ['ZRANGE', key, 0, LIST_LIMIT - 1] : ['ZREVRANGE', key, 0, LIST_LIMIT - 1],
  ]);
  const ids = results[1];
  if (results.length !== 2 || !ids || ids.error || !Array.isArray(ids.result)) return null;
  const keys = ids.result.filter((id): id is string => typeof id === 'string');
  if (keys.length === 0) return [];
  const records = await runRedisPipeline(keys.map((id) => ['GET', ERROR_REPORT_KEY(id)]));
  if (records.length !== keys.length || records.some((record) => record.error)) return null;
  // A record that expired between the prune and the read is skipped, not shown empty.
  return records.map((record) => parseReport(record.result)).filter((r): r is StoredErrorReport => r !== null);
}

/** true when this caller now reviews the report alone, false when another review holds it, 'unavailable' on error. */
export async function claimReview(id: string): Promise<boolean | 'unavailable'> {
  const [lock] = await runRedisPipeline([['SET', REVIEW_LOCK_KEY(id), String(Date.now()), 'NX', 'EX', REVIEW_LOCK_TTL_S]]);
  if (!lock || lock.error) return 'unavailable';
  return lock.result === 'OK';
}

export async function releaseReview(id: string): Promise<void> {
  await runRedisPipeline([['DEL', REVIEW_LOCK_KEY(id)]]);
}

export async function readErrorReport(id: string): Promise<StoredErrorReport | null | 'unavailable'> {
  const [record] = await runRedisPipeline([['GET', ERROR_REPORT_KEY(id)]]);
  if (!record || record.error) return 'unavailable';
  return parseReport(record.result);
}

/**
 * Record a decision in one transaction: the record, the queue move and, when
 * accepting, the label-log entry commit together or not at all. The caller
 * holds the review claim. Returns the reviewed report, or 'unavailable' when
 * the transaction was not confirmed (nothing applied; the report stays pending).
 */
export async function reviewErrorReport(
  report: StoredErrorReport,
  decision: 'accepted' | 'rejected',
  publicNote: string,
  now: number,
): Promise<StoredErrorReport | 'unavailable'> {
  const reviewed: StoredErrorReport = { ...report, status: decision, reviewedAt: now, publicNote };
  const commands = [
    ['SET', ERROR_REPORT_KEY(report.id), JSON.stringify(reviewed), 'XX', 'EX', ERROR_REPORT_TTL_S],
    ['ZREM', PENDING_REPORTS_KEY, report.id],
    ['ZADD', REVIEWED_REPORTS_KEY, now, report.id],
    ['ZREMRANGEBYRANK', REVIEWED_REPORTS_KEY, 0, -(REVIEWED_REPORTS_MAX + 1)],
    ...(decision === 'accepted' ? labelChangeCommands(correctionEntry(report, publicNote, now)) : []),
  ];
  return confirmed(await runRedisTransaction(commands), commands.length) ? reviewed : 'unavailable';
}
