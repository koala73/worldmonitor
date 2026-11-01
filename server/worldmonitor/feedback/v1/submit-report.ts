/**
 * RPC: submitReport -- an agent reports a bug, a missing capability, bad data,
 * or a security concern (#8721). REST callers are always anonymous: the route
 * is in PUBLIC_NO_AUTH_RPC_PATHS, so the gateway resolves no key or session
 * (threat model, "Entry paths"). Identity fields in the body are ignored.
 */

import type {
  ServerContext,
  SubmitReportRequest,
  SubmitReportResponse,
} from '../../../../src/generated/server/worldmonitor/feedback/v1/service_server';
import { ApiError, ValidationError } from '../../../../src/generated/server/worldmonitor/feedback/v1/service_server';
import { submitAgentFeedback } from '../../../_shared/agent-feedback';
import { getClientIp } from '../../../_shared/client-ip';

export async function submitReport(
  ctx: ServerContext,
  req: SubmitReportRequest,
): Promise<SubmitReportResponse> {
  const outcome = await submitAgentFeedback(
    {
      kind: req.kind,
      surface: req.surface,
      summary: req.summary,
      expected: req.expected,
      actual: req.actual,
      requestId: req.requestId,
      clientName: req.clientName,
    },
    { authKind: 'anonymous' },
    {
      clientIp: getClientIp(ctx.request),
      userAgent: ctx.request.headers.get('user-agent') ?? '',
    },
  );
  if (!outcome.ok) {
    if (outcome.status === 400) {
      throw new ValidationError([{ field: outcome.field ?? 'body', description: outcome.message }]);
    }
    throw new ApiError(outcome.status, outcome.message, '');
  }
  return {
    reportId: outcome.reportId,
    status: outcome.status,
    advisoryUrl: outcome.advisoryUrl ?? '',
    notice: outcome.notice ?? '',
  };
}
