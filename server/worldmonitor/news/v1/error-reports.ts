/**
 * #9093 error-report RPCs: SubmitErrorReport (public), ListErrorReports and
 * ReviewErrorReport (operators, X-Trust-Review-Key = TRUST_REVIEW_SECRET).
 * A report is never applied automatically.
 */
import type {
  ErrorReport,
  ListErrorReportsRequest,
  ListErrorReportsResponse,
  ReviewErrorReportRequest,
  ReviewErrorReportResponse,
  ServerContext,
  SubmitErrorReportRequest,
  SubmitErrorReportResponse,
} from '../../../../src/generated/server/worldmonitor/news/v1/service_server';
import { ApiError, ValidationError } from '../../../../src/generated/server/worldmonitor/news/v1/service_server';
import { markNoCacheResponse } from '../../../_shared/response-headers';
import {
  claimReview,
  isTrustReviewer,
  listErrorReports as readReports,
  readErrorReport,
  releaseReview,
  reviewErrorReport as recordReview,
  storeErrorReport,
  type StoredErrorReport,
} from '../../../_shared/error-reports';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STORY_ID_RE = /^[0-9a-f]{64}$/;
const REPORT_ID_RE = /^[0-9a-f-]{36}$/;

/** Drops control characters other than newline and tab. */
const clean = (value: string, max: number) =>
  value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);

function cleanUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    if (url.username || url.password) return '';
    return url.href.slice(0, 2048);
  } catch {
    return '';
  }
}

function toWire(report: StoredErrorReport): ErrorReport {
  return {
    id: report.id,
    status: report.status,
    message: report.message,
    storyId: report.storyId,
    url: report.url,
    contact: report.contact,
    createdAt: report.createdAt,
    reviewedAt: report.reviewedAt,
    publicNote: report.publicNote,
  };
}

export async function submitErrorReport(
  ctx: ServerContext,
  req: SubmitErrorReportRequest,
): Promise<SubmitErrorReportResponse> {
  markNoCacheResponse(ctx.request);
  // Honeypot: accept and discard, so a bot learns nothing.
  if (req.website) return { status: 'received', reportId: '' };

  const message = clean(req.message ?? '', 2000);
  if (message.length < 10) {
    throw new ValidationError([{ field: 'message', description: 'Describe what is wrong in at least 10 characters' }]);
  }
  const storyId = (req.storyId ?? '').trim().toLowerCase();
  if (storyId && !STORY_ID_RE.test(storyId)) {
    throw new ValidationError([{ field: 'story_id', description: 'Invalid story id' }]);
  }
  const url = cleanUrl(req.url ?? '');
  if ((req.url ?? '').trim() && !url) {
    throw new ValidationError([{ field: 'url', description: 'URL must be http or https' }]);
  }
  const contact = (req.contact ?? '').trim().slice(0, 320);
  if (contact && !EMAIL_RE.test(contact)) {
    throw new ValidationError([{ field: 'contact', description: 'Invalid email' }]);
  }

  const report: StoredErrorReport = {
    id: crypto.randomUUID(),
    status: 'pending',
    message,
    storyId,
    url,
    contact,
    createdAt: Date.now(),
    reviewedAt: 0,
    publicNote: '',
  };
  const stored = await storeErrorReport(report);
  if (stored === 'unavailable') throw new ApiError(503, 'Reports are temporarily unavailable', '');
  return stored === 'received'
    ? { status: 'received', reportId: report.id }
    : { status: 'queue-full', reportId: '' };
}

export async function listErrorReports(
  ctx: ServerContext,
  req: ListErrorReportsRequest,
): Promise<ListErrorReportsResponse> {
  markNoCacheResponse(ctx.request);
  if (!(await isTrustReviewer(ctx.request))) throw new ApiError(401, 'Unauthorized', '');
  const reports = await readReports(req.status === 'reviewed' ? 'reviewed' : 'pending');
  return reports === null
    ? { reports: [], state: 'unavailable' }
    : { reports: reports.map(toWire), state: 'ok' };
}

export async function reviewErrorReport(
  ctx: ServerContext,
  req: ReviewErrorReportRequest,
): Promise<ReviewErrorReportResponse> {
  markNoCacheResponse(ctx.request);
  if (!(await isTrustReviewer(ctx.request))) throw new ApiError(401, 'Unauthorized', '');
  const decision = req.decision === 'accept' ? 'accepted' : req.decision === 'reject' ? 'rejected' : null;
  if (!decision) throw new ValidationError([{ field: 'decision', description: 'accept or reject' }]);
  const publicNote = clean(req.publicNote ?? '', 500);
  if (decision === 'accepted' && publicNote.length === 0) {
    throw new ValidationError([{ field: 'public_note', description: 'An accepted report needs a public note: it is what the label log publishes' }]);
  }
  const id = (req.reportId ?? '').trim().toLowerCase();
  if (!REPORT_ID_RE.test(id)) throw new ValidationError([{ field: 'report_id', description: 'Invalid report id' }]);

  const claim = await claimReview(id);
  if (claim === 'unavailable') throw new ApiError(503, 'Reports are temporarily unavailable', '');
  if (!claim) throw new ApiError(409, 'Report is being reviewed', '');
  try {
    const report = await readErrorReport(id);
    if (report === 'unavailable') throw new ApiError(503, 'Reports are temporarily unavailable', '');
    if (!report) throw new ApiError(404, 'Report not found', '');
    if (report.status !== 'pending') throw new ApiError(409, `Report already ${report.status}`, '');
    const reviewed = await recordReview(report, decision, publicNote, Date.now());
    if (reviewed === 'unavailable') throw new ApiError(503, 'Review could not be saved; the report is still pending', '');
    return { report: toWire(reviewed) };
  } finally {
    await releaseReview(id);
  }
}
