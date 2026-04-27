import { CHOKEPOINT_REGISTRY } from '../../../_shared/chokepoint-registry';

export const WEBHOOK_TTL = 86400 * 30; // 30 days
export const VALID_CHOKEPOINT_IDS = new Set(CHOKEPOINT_REGISTRY.map(c => c.id));

// Private IP ranges + known cloud metadata hostnames blocked at registration.
//
// DNS rebinding is NOT mitigated by isBlockedCallbackUrl below — the Vercel
// Edge runtime can't resolve hostnames before the request goes out. Defense
// against a hostname that returns a public IP at registration time and a
// private IP later (or different IPs per resolution) MUST happen in the
// delivery worker that actually POSTs to the callback URL:
//
//   1. Re-validate the URL with isBlockedCallbackUrl right before each send.
//   2. Resolve the hostname to its current IP via dns.promises.lookup
//      (Node runtime — Edge can't do this).
//   3. Verify the resolved IP is not in PRIVATE_HOSTNAME_PATTERNS or
//      BLOCKED_METADATA_HOSTNAMES.
//   4. Issue the fetch using the resolved IP with the Host header preserved
//      so TLS still validates against the original hostname.
//
// As of the #3242 followup audit, no delivery worker for shipping/v2 webhooks
// exists in this repo — tracked in issue #3288. Anyone landing delivery code
// MUST import the patterns + sets above and apply steps 1–3 before each send.
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
