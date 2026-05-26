import { CHOKEPOINT_REGISTRY } from '../../../_shared/chokepoint-registry';

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

export function isBlockedResolvedAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const v4Mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const addr = v4Mapped?.[1] ?? normalized;

  if (addr === '::' || addr === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(addr)) return true; // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/i.test(addr)) return true; // fe80::/10 link local
  if (/^ff[0-9a-f]{2}:/i.test(addr)) return true; // ff00::/8 multicast
  if (/^2001:0?db8:/i.test(addr)) return true; // 2001:db8::/32 documentation

  const parts = addr.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24 deprecated 6to4
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // multicast + reserved
  return false;
}

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
