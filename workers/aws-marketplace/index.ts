import { callMarketplaceBackend, getMarketplaceEntitlements, type MarketplaceIdentity } from '../../server/_shared/aws-marketplace';

type SqsRecord = { messageId: string; body: string };
type Event = { Records?: SqsRecord[]; source?: string };
type LambdaContext = { getRemainingTimeInMillis?: () => number };
type EventBridgeNotification = {
  id?: unknown;
  source?: unknown;
  'detail-type'?: unknown;
  account?: unknown;
  region?: unknown;
  time?: unknown;
  detail?: {
    product?: { code?: unknown };
    license?: { arn?: unknown };
    acceptor?: { accountId?: unknown };
  };
};

const EVENT_TYPES = new Set(['License Updated - Manufacturer', 'License Deprovisioned - Manufacturer']);
const MAX_DUE_PAGES = 100;
const MIN_REMAINING_MS = 30_000;

function expectedConfig(env: NodeJS.ProcessEnv) {
  const account = env.AWS_MARKETPLACE_SELLER_ACCOUNT_ID;
  const region = env.AWS_MARKETPLACE_REGION;
  const products = env.AWS_MARKETPLACE_PRODUCT_CODES?.split(',').map(s => s.trim()) ?? [];
  if (!/^\d{12}$/.test(account ?? '') || region !== 'us-east-1' || !products.length || products.some(s => !s)) throw new Error('Marketplace worker configuration is incomplete');
  return { account, region, products };
}

export function parseNotification(raw: string, env: NodeJS.ProcessEnv = process.env): { identity: MarketplaceIdentity; eventId: string; eventTime?: number } | null {
  const event = JSON.parse(raw) as EventBridgeNotification;
  const config = expectedConfig(env);
  if (event.source !== 'aws.agreement-marketplace' || !EVENT_TYPES.has(String(event['detail-type'])) ||
      event.account !== config.account || event.region !== config.region) throw new Error('Marketplace event source mismatch');
  const code = event.detail?.product?.code;
  if (typeof code !== 'string' || !config.products.includes(code)) return null;
  const accountId = event.detail?.acceptor?.accountId;
  const licenseArn = event.detail?.license?.arn;
  if (typeof event.id !== 'string' || !event.id || typeof accountId !== 'string' || !/^\d{12}$/.test(accountId) ||
      typeof licenseArn !== 'string' || !licenseArn.startsWith('arn:aws:license-manager:')) throw new Error('Marketplace event identity is invalid');
  const eventTime = typeof event.time === 'string' ? Date.parse(event.time) : NaN;
  return {
    identity: { productCode: code, customerAWSAccountId: accountId, licenseArn },
    eventId: event.id,
    ...(Number.isFinite(eventTime) ? { eventTime } : {}),
  };
}

export async function refreshLicense(identity: MarketplaceIdentity, eventId?: string, eventTime?: number): Promise<void> {
  const begun = await callMarketplaceBackend<{ licenseId: string; revision: number; duplicate: boolean }>({
    operation: 'beginRefresh',
    productCode: identity.productCode,
    customerAWSAccountId: identity.customerAWSAccountId,
    licenseArn: identity.licenseArn,
    ...(eventId ? { eventId } : {}), ...(eventTime ? { eventTime } : {}),
  });
  if (begun.duplicate) return;
  const entitlements = await getMarketplaceEntitlements(identity);
  const applied = await callMarketplaceBackend<{ applied: boolean }>({
    operation: 'applyRefresh', licenseId: begun.licenseId, revision: begun.revision,
    checkedAt: Date.now(), entitlements, ...(eventId ? { eventId } : {}),
  });
  if (!applied.applied) throw new Error('Marketplace refresh revision conflict');
}

export async function reconcileDue(context: LambdaContext = {}): Promise<void> {
  const seen = new Set<string>();
  let cursor: string | undefined;
  let failures = 0;
  for (let page = 0; page < MAX_DUE_PAGES; page++) {
    if ((context.getRemainingTimeInMillis?.() ?? Infinity) < MIN_REMAINING_MS) throw new Error('Marketplace reconciliation time budget exhausted');
    const result = await callMarketplaceBackend<{ licenses: Array<MarketplaceIdentity & { id: string }>; cursor?: string }>({
      operation: 'listDue', limit: 25, ...(cursor ? { cursor } : {}),
    });
    for (let offset = 0; offset < result.licenses.length; offset += 5) {
      if ((context.getRemainingTimeInMillis?.() ?? Infinity) < MIN_REMAINING_MS) throw new Error('Marketplace reconciliation time budget exhausted');
      const settled = await Promise.allSettled(result.licenses.slice(offset, offset + 5).map(license => refreshLicense(license)));
      failures += settled.filter(result => result.status === 'rejected').length;
    }
    if (!result.cursor) {
      if (failures) throw new Error(`Marketplace reconciliation failed for ${failures} licenses`);
      return;
    }
    if (seen.has(result.cursor)) throw new Error('Marketplace reconciliation cursor repeated');
    seen.add(result.cursor);
    cursor = result.cursor;
  }
  throw new Error('Marketplace reconciliation page limit reached');
}

export async function handler(event: Event, context: LambdaContext = {}): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> {
  expectedConfig(process.env);
  if (!Array.isArray(event.Records)) {
    await reconcileDue(context);
    return { batchItemFailures: [] };
  }
  const failures: Array<{ itemIdentifier: string }> = [];
  for (let index = 0; index < event.Records.length; index++) {
    const record = event.Records[index]!;
    if ((context.getRemainingTimeInMillis?.() ?? Infinity) < MIN_REMAINING_MS) {
      failures.push(...event.Records.slice(index).map(item => ({ itemIdentifier: item.messageId })));
      break;
    }
    try {
      const notification = parseNotification(record.body);
      if (notification) await refreshLicense(notification.identity, notification.eventId, notification.eventTime);
    } catch (error) {
      console.error('Marketplace event refresh failed', error instanceof Error ? error.name : 'UnknownError');
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}
