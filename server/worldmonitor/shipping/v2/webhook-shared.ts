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
