import { getConvexApi, getConvexClient } from './convex-client';

export type ApiPlanLimitNoticeState = 'warning' | 'over_limit' | 'sustained_burst';
export type ApiPlanLimitDimension =
  | 'api_daily_requests'
  | 'api_minute_burst'
  | 'mcp_daily_calls'
  | 'mcp_minute_burst';
export type ApiPlanLimitCtaKind = 'checkout' | 'billing_portal' | 'contact_support' | 'none';

export interface ApiPlanLimitNotice {
  _id: string;
  userId: string;
  planKey: string;
  dimension: ApiPlanLimitDimension;
  state: ApiPlanLimitNoticeState;
  windowKey: string;
  usage: number;
  limit: number | null;
  usageRatio: number | null;
  upgradeTargetPlanKey?: string;
  ctaKind: ApiPlanLimitCtaKind;
  blockedReason?: string;
}

export async function listCurrentPlanLimitNotices(): Promise<ApiPlanLimitNotice[]> {
  const client = await getConvexClient();
  const api = await getConvexApi();
  if (!client || !api) return [];
  return await client.query((api as any).apiPlanLimitNotices.listCurrentForUser, {});
}

export async function acknowledgePlanLimitNotice(noticeId: string): Promise<void> {
  const client = await getConvexClient();
  const api = await getConvexApi();
  if (!client || !api) return;
  await client.mutation((api as any).apiPlanLimitNotices.acknowledgeNotice, { noticeId });
}
