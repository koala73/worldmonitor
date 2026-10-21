import {
  getConvexApi,
  getConvexClient,
  waitForConvexAuthForUser,
} from './convex-client';
import { getCurrentClerkUser } from './clerk';
import {
  assertAccountStillCurrent,
  settleAccountOperation,
} from './account-operation';

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
  const userId = getCurrentClerkUser()?.id;
  if (!userId) return [];
  const [client, api] = await Promise.all([getConvexClient(), getConvexApi()]);
  if (!client || !api) return [];
  if (!await waitForConvexAuthForUser(userId)) {
    assertAccountStillCurrent(userId, 'loading API plan-limit notices');
    throw new Error('Authentication unavailable while loading API plan-limit notices. Try again.');
  }
  return settleAccountOperation(
    userId,
    'loading API plan-limit notices',
    () => client.query((api as any).apiPlanLimitNotices.listCurrentForUser, {}),
  );
}

export async function acknowledgePlanLimitNotice(noticeId: string): Promise<void> {
  const userId = getCurrentClerkUser()?.id;
  if (!userId) throw new Error('Sign in to acknowledge API plan-limit notices.');
  const [client, api] = await Promise.all([getConvexClient(), getConvexApi()]);
  if (!client || !api) throw new Error('Convex unavailable');
  if (!await waitForConvexAuthForUser(userId)) {
    throw new Error('Account changed while acknowledging the API plan-limit notice. Try again.');
  }
  await settleAccountOperation(
    userId,
    'acknowledging the API plan-limit notice',
    () => client.mutation((api as any).apiPlanLimitNotices.acknowledgeNotice, { noticeId }),
  );
}
