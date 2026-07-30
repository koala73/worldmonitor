import { CHOKEPOINT_REGISTRY } from '../../../_shared/chokepoint-registry';
import { isBlockedResolvedAddress } from '../../../_shared/ip-address-classification';

export const WEBHOOK_TTL = 86400 * 30; // 30 days
export const VALID_CHOKEPOINT_IDS = new Set(CHOKEPOINT_REGISTRY.map(c => c.id));

// Private IP ranges + known cloud metadata hostnames blocked at registration
// and again immediately before webhook delivery. Registration-time checks are
// not sufficient because a callback hostname can later rebind to internal
// infrastructure.
export const PRIVATE_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^169\.254\.\d+\.\d+$/,
  /^fd[0-9a-f]{2}:/i,
  /^fe80:/i,
  /^::1$/,
  /^0\.0\.0\.0$/,
  /^0\.\d+\.\d+\.\d+$/,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/,
];

export const BLOCKED_METADATA_HOSTNAMES = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.internal',
  'instance-data',
  'metadata',
  'computemetadata',
  'link-local.s3.amazonaws.com',
]);

const DNS_RESOLUTION_TIMEOUT_MS = 3_000;
const DNS_JSON_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const TEST_RESOLVER_KEY = Symbol.for('worldmonitor.shippingV2.resolveWebhookHostnameForTest');

type ResolveHostname = (hostname: string) => Promise<string[]>;

function isIpLiteral(hostname: string): boolean {
  return hostname.includes(':') || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname);
}

function getResolveHostnameForTest(): ResolveHostname | undefined {
  const candidate = Reflect.get(globalThis, TEST_RESOLVER_KEY);
  return typeof candidate === 'function' ? candidate as ResolveHostname : undefined;
}

export { isBlockedResolvedAddress };

export function isBlockedCallbackUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return 'callbackUrl is not a valid URL';
  }

  if (parsed.protocol !== 'https:') {
    return 'callbackUrl must use https';
  }

  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKED_METADATA_HOSTNAMES.has(hostname)) {
    return 'callbackUrl hostname is a blocked metadata endpoint';
  }

  if (isBlockedResolvedAddress(hostname)) {
    return `callbackUrl resolves to a private/reserved address: ${hostname}`;
  }

  for (const pattern of PRIVATE_HOSTNAME_PATTERNS) {
    if (pattern.test(hostname)) {
      return `callbackUrl resolves to a private/reserved address: ${hostname}`;
    }
  }

  return null;
}

async function defaultResolveHostname(hostname: string): Promise<string[]> {
  const resolveHostnameForTest = getResolveHostnameForTest();
  if (resolveHostnameForTest) return resolveHostnameForTest(hostname);

  const resolveRecordType = async (recordType: 'A' | 'AAAA'): Promise<string[]> => {
    const url = new URL(DNS_JSON_ENDPOINT);
    url.searchParams.set('name', hostname);
    url.searchParams.set('type', recordType);
    const response = await fetch(url, {
      headers: {
        Accept: 'application/dns-json',
        'User-Agent': 'WorldMonitor-ShippingV2-Webhooks/1.0',
      },
      signal: AbortSignal.timeout(DNS_RESOLUTION_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`DNS ${recordType} lookup failed: HTTP ${response.status}`);
    const data = await response.json() as { Status?: number; Answer?: Array<{ type?: number; data?: string }> };
    if (data.Status !== 0) throw new Error(`DNS ${recordType} lookup failed: status ${data.Status}`);
    const expectedType = recordType === 'A' ? 1 : 28;
    return (data.Answer ?? [])
      .filter(answer => answer.type === expectedType && typeof answer.data === 'string')
      .map(answer => answer.data!);
  };
  const records = await Promise.all([resolveRecordType('A'), resolveRecordType('AAAA')]);
  return records.flat();
}

/**
 * Validate the current DNS answer before storing a webhook. Delivery makes the
 * same check immediately before send and pins the resulting socket, which
 * keeps this fail-fast check from becoming the only SSRF control.
 */
export async function assertCallbackUrlRegistrationSafe(
  callbackUrl: string,
  resolveHostname: ResolveHostname = defaultResolveHostname,
): Promise<void> {
  const staticError = isBlockedCallbackUrl(callbackUrl);
  if (staticError) throw new Error(staticError);

  const hostname = new URL(callbackUrl).hostname.toLowerCase();
  if (isIpLiteral(hostname)) return;
  let resolvedAddresses: string[];
  try {
    resolvedAddresses = await resolveHostname(hostname);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`callbackUrl DNS resolution failed: ${message}`);
  }
  if (!resolvedAddresses.length) throw new Error('callbackUrl DNS resolution returned no addresses');
  const blocked = resolvedAddresses.find(isBlockedResolvedAddress);
  if (blocked) throw new Error('callbackUrl resolves to a private/reserved address');
}

export async function generateSecret(): Promise<string> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function generateSubscriberId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return 'wh_' + [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function webhookKey(subscriberId: string): string {
  return `webhook:sub:${subscriberId}:v1`;
}

export function ownerIndexKey(ownerHash: string): string {
  return `webhook:owner:${ownerHash}:v1`;
}

/** SHA-256 hash of the caller's API key — used as ownerTag and owner index key. Never secret. */
export async function callerFingerprint(req: Request): Promise<string> {
  const key =
    req.headers.get('X-WorldMonitor-Key') ??
    req.headers.get('X-Api-Key') ??
    '';
  if (!key) return 'anon';
  const encoded = new TextEncoder().encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export interface WebhookRecord {
  subscriberId: string;
  ownerTag: string;
  callbackUrl: string;
  chokepointIds: string[];
  alertThreshold: number;
  createdAt: string;
  active: boolean;
  secret: string;
}
