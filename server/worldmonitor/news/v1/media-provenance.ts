/**
 * #9096 media provenance RPCs. A check runs on the Railway worker
 * (scripts/media-provenance-worker.mjs): these handlers enqueue it and serve
 * its result to the caller who started it.
 *
 * CheckMediaProvenance / GetMediaProvenance: PRO-gated, any public media URL.
 * CheckReportMedia / GetReportMedia: operators (X-Trust-Review-Key), the link a
 * reader submitted with an error report.
 */
import type {
  CheckMediaProvenanceRequest,
  CheckReportMediaRequest,
  GetMediaProvenanceRequest,
  GetMediaProvenanceResponse,
  GetReportMediaRequest,
  MediaCheckJob,
  MediaCredentials,
  MediaEarliestAppearance,
  MediaProvenance,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/news/v1/service_server';
import { ApiError, ValidationError } from '../../../../src/generated/server/worldmonitor/news/v1/service_server';
import {
  MEDIA_CAVEATS,
  MEDIA_JOB_ID_RE,
  MEDIA_OWNER_TOKEN_RE,
  MEDIA_QUEUE_KEY,
  MEDIA_QUEUE_MAX_DEPTH,
  MEDIA_RESULT_TTL_SECONDS,
  MEDIA_URL_MAX_CHARS,
  mediaOwnerKey,
  mediaResultKey,
} from '../../../../shared/media-provenance-contract.js';
import { isTrustReviewer, readErrorReport } from '../../../_shared/error-reports';
import { requirePremiumRpcAccess, type PremiumCallerIdentity } from '../../../_shared/premium-check';
import { getRawJson, runRedisPipeline, runRedisTransaction } from '../../../_shared/redis';
import { markNoCacheResponse, setResponseHeader, setSuccessStatusOverride } from '../../../_shared/response-headers';

const REPORT_ID_RE = /^[0-9a-f-]{36}$/;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The principal a check belongs to. User-bound callers share one token across
 * credentials; a key without a user id is hashed, never stored raw. Operators
 * share one token, separated from every user token by its prefix.
 */
async function proOwnerToken(identity: PremiumCallerIdentity, request: Request): Promise<string | null> {
  if (!identity.isPremium) return null;
  const material = identity.userId
    ? `media:user:${identity.userId}`
    : `media:key:${request.headers.get('X-WorldMonitor-Key') ?? request.headers.get('X-Api-Key') ?? ''}`;
  if (material === 'media:key:') return null;
  const token = await sha256Hex(material);
  return MEDIA_OWNER_TOKEN_RE.test(token) ? token : null;
}

const operatorOwnerToken = () => sha256Hex('media:operator:trust-review');

/** The URL's form only; the worker checks DNS and every redirect before fetching. */
export function mediaUrlFormProblem(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > MEDIA_URL_MAX_CHARS) return 'url must be a URL of at most 2048 characters';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'url is not a valid URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'url must use http or https';
  if (url.username || url.password) return 'url must not contain credentials';
  if (url.port && url.port !== '80' && url.port !== '443') return 'url must use the standard web port';
  if (!url.hostname.includes('.')) return 'url must point to a public website';
  return null;
}

function generateJobId(now = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let suffix = '';
  for (const byte of bytes) suffix += byte.toString(16).padStart(2, '0');
  return `media:${now}:${suffix}`;
}

async function enqueue(ctx: ServerContext, url: string, owner: string, statusPath: string): Promise<MediaCheckJob> {
  const [depth] = await runRedisPipeline([['LLEN', MEDIA_QUEUE_KEY]], true);
  if (typeof depth?.result === 'number' && depth.result > MEDIA_QUEUE_MAX_DEPTH) {
    throw new ApiError(429, 'Media checks are busy, please try again in a minute', '');
  }
  const jobId = generateJobId();
  const payload = JSON.stringify({ jobId, url, owner, enqueuedAt: Date.now() });
  // Bind the owner and enqueue together: a job whose owner write failed could never be polled.
  const [setEntry, pushEntry] = await runRedisTransaction([
    ['SET', mediaOwnerKey(jobId), JSON.stringify(owner), 'EX', String(MEDIA_RESULT_TTL_SECONDS)],
    ['RPUSH', MEDIA_QUEUE_KEY, payload],
  ], true);
  if (!setEntry || setEntry.error || setEntry.result !== 'OK' || !pushEntry || pushEntry.error || typeof pushEntry.result !== 'number') {
    throw new ApiError(502, 'Failed to queue the media check', '');
  }
  const statusUrl = `${statusPath}?job_id=${encodeURIComponent(jobId)}`;
  setSuccessStatusOverride(ctx.request, 202);
  setResponseHeader(ctx.request, 'Location', statusUrl);
  return { jobId, status: 'pending', statusUrl };
}

const str = (value: unknown, max = 2048) => (typeof value === 'string' ? value.slice(0, max) : '');
const nonNegativeInt = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0);
const oneOf = (value: unknown, allowed: readonly string[], fallback: string) =>
  (typeof value === 'string' && allowed.includes(value) ? value : fallback);

function coerceCredentials(raw: unknown): MediaCredentials {
  const c = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const actions = Array.isArray(c.actions) ? c.actions : [];
  return {
    state: oneOf(c.state, ['found', 'none', 'unreadable'], 'unreadable'),
    signer: str(c.signer, 200),
    signerCommonName: str(c.signerCommonName, 200),
    signerTrust: oneOf(c.signerTrust, ['trusted', 'untrusted', 'unknown'], 'unknown'),
    claimGenerator: str(c.claimGenerator, 200),
    signedAt: str(c.signedAt, 40),
    actions: actions.slice(0, 50).flatMap((a) => (a && typeof a === 'object' && typeof (a as Record<string, unknown>).action === 'string'
      ? [{
          action: str((a as Record<string, unknown>).action, 80),
          softwareAgent: str((a as Record<string, unknown>).softwareAgent, 200),
          digitalSourceType: str((a as Record<string, unknown>).digitalSourceType, 200),
        }]
      : [])),
    declaresAiGeneration: c.declaresAiGeneration === true,
    ingredientCount: nonNegativeInt(c.ingredientCount),
    validationState: oneOf(c.validationState, ['valid', 'invalid', 'trusted'], ''),
    contentChangedAfterSigning: c.contentChangedAfterSigning === true,
    failureCodes: (Array.isArray(c.failureCodes) ? c.failureCodes : []).filter((code): code is string => typeof code === 'string').slice(0, 20).map((code) => code.slice(0, 100)),
  };
}

function coerceEarliest(raw: unknown): MediaEarliestAppearance {
  const e = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const copies = Array.isArray(e.copies) ? e.copies : [];
  return {
    state: oneOf(e.state, ['ok', 'unsupported-media', 'not-configured', 'cap-reached', 'unavailable'], 'unavailable'),
    provider: str(e.provider, 40),
    copies: copies.slice(0, 10).flatMap((copy) => {
      const c = copy && typeof copy === 'object' ? (copy as Record<string, unknown>) : null;
      const pageUrl = c ? str(c.pageUrl) : '';
      if (!c || !/^https?:\/\//.test(pageUrl) || !/^\d{4}-\d{2}-\d{2}$/.test(str(c.crawlDate, 10))) return [];
      return [{ domain: str(c.domain, 253), pageUrl, crawlDate: str(c.crawlDate, 10) }];
    }),
    totalMatches: nonNegativeInt(e.totalMatches),
    searchedAt: str(e.searchedAt, 40),
  };
}

/** A worker result, read back as untrusted JSON. */
export function coerceMediaProvenance(raw: unknown): MediaProvenance | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  return {
    url: str(r.url),
    mediaType: str(r.mediaType, 40),
    bytes: nonNegativeInt(r.bytes),
    sha256: /^[a-f0-9]{64}$/.test(str(r.sha256, 64)) ? str(r.sha256, 64) : '',
    fetchedAt: str(r.fetchedAt, 40),
    credentials: coerceCredentials(r.credentials),
    earliest: coerceEarliest(r.earliest),
    // The caveats are fixed text; the stored copy is not trusted.
    caveats: [...MEDIA_CAVEATS],
  };
}

async function readStatus(jobId: string, owner: string): Promise<GetMediaProvenanceResponse> {
  if (!MEDIA_JOB_ID_RE.test(jobId)) throw new ValidationError([{ field: 'job_id', description: 'Invalid job id' }]);
  // Another principal's job reads as not found, so ids cannot be probed.
  const boundOwner = await getRawJson(mediaOwnerKey(jobId)).catch(() => null);
  if (boundOwner !== owner) throw new ApiError(404, 'Media check not found', '');
  const envelope = await getRawJson(mediaResultKey(owner, jobId)).catch(() => null) as { status?: unknown; result?: unknown; error?: unknown } | null;
  if (!envelope || typeof envelope !== 'object') return { status: 'pending', error: '' };
  if (envelope.status === 'done') {
    const result = coerceMediaProvenance(envelope.result);
    return result ? { status: 'done', result, error: '' } : { status: 'failed', error: 'The check could not be completed.' };
  }
  if (envelope.status === 'failed') return { status: 'failed', error: str(envelope.error, 300) || 'The check could not be completed.' };
  return { status: 'pending', error: '' };
}

export async function checkMediaProvenance(ctx: ServerContext, req: CheckMediaProvenanceRequest): Promise<MediaCheckJob> {
  markNoCacheResponse(ctx.request);
  const identity = await requirePremiumRpcAccess(ctx.request, ApiError, 'PRO subscription required');
  const problem = mediaUrlFormProblem(req.url ?? '');
  if (problem) throw new ValidationError([{ field: 'url', description: problem }]);
  const owner = await proOwnerToken(identity, ctx.request);
  if (!owner) throw new ApiError(403, 'PRO subscription required', '');
  return enqueue(ctx, req.url.trim(), owner, '/api/news/v1/get-media-provenance');
}

export async function getMediaProvenance(ctx: ServerContext, req: GetMediaProvenanceRequest): Promise<GetMediaProvenanceResponse> {
  markNoCacheResponse(ctx.request);
  const identity = await requirePremiumRpcAccess(ctx.request, ApiError, 'PRO subscription required');
  const owner = await proOwnerToken(identity, ctx.request);
  if (!owner) throw new ApiError(403, 'PRO subscription required', '');
  return readStatus(req.jobId ?? '', owner);
}

export async function checkReportMedia(ctx: ServerContext, req: CheckReportMediaRequest): Promise<MediaCheckJob> {
  markNoCacheResponse(ctx.request);
  if (!(await isTrustReviewer(ctx.request))) throw new ApiError(401, 'Unauthorized', '');
  const id = (req.reportId ?? '').trim();
  if (!REPORT_ID_RE.test(id)) throw new ValidationError([{ field: 'report_id', description: 'Invalid report id' }]);
  const report = await readErrorReport(id);
  if (report === 'unavailable') throw new ApiError(503, 'Reports are unavailable', '');
  if (!report) throw new ApiError(404, 'Report not found', '');
  const problem = report.url ? mediaUrlFormProblem(report.url) : 'The report has no link to check';
  if (problem) throw new ValidationError([{ field: 'report_id', description: problem }]);
  return enqueue(ctx, report.url, await operatorOwnerToken(), '/api/news/v1/get-report-media');
}

export async function getReportMedia(ctx: ServerContext, req: GetReportMediaRequest): Promise<GetMediaProvenanceResponse> {
  markNoCacheResponse(ctx.request);
  if (!(await isTrustReviewer(ctx.request))) throw new ApiError(401, 'Unauthorized', '');
  return readStatus(req.jobId ?? '', await operatorOwnerToken());
}
