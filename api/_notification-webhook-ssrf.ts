const BLOCKED_METADATA_HOSTNAMES = new Set([
  'localhost',
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

type ResolveHostname = (hostname: string) => Promise<string[]>;

function isIpLiteral(hostname: string): boolean {
  return hostname.includes(':') || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname);
}

function ipv4Parts(value: string): [number, number, number, number] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map(part => Number(part));
  if (nums.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return nums as [number, number, number, number];
}

function ipv4FromMappedIpv6(value: string): string | null {
  const dotted = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const dottedAddress = dotted?.[1];
  if (dottedAddress && ipv4Parts(dottedAddress)) return dottedAddress;

  const hex = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hex) return null;
  const hi = Number.parseInt(hex[1]!, 16);
  const lo = Number.parseInt(hex[2]!, 16);
  if (!Number.isInteger(hi) || !Number.isInteger(lo) || hi < 0 || hi > 0xffff || lo < 0 || lo > 0xffff) {
    return null;
  }
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

// Parse an IPv6 literal (compressed or expanded, any case, optional trailing
// dotted IPv4) into exactly eight 16-bit hextets, or null when it is not a
// syntactically valid IPv6 address.
function ipv6ToHextets(value: string): number[] | null {
  if (typeof value !== 'string' || !value.includes(':')) return null;
  if ((value.match(/::/g) || []).length > 1) return null;

  const parseSide = (side: string): number[] | null => {
    if (side === '') return [];
    const tokens = side.split(':');
    const hextets: number[] = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]!;
      if (token.includes('.')) {
        if (i !== tokens.length - 1) return null;
        const parts = ipv4Parts(token);
        if (!parts) return null;
        hextets.push((parts[0] << 8) | parts[1]);
        hextets.push((parts[2] << 8) | parts[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(token)) return null;
        hextets.push(Number.parseInt(token, 16));
      }
    }
    return hextets;
  };

  const compressionIndex = value.indexOf('::');
  if (compressionIndex === -1) {
    const groups = parseSide(value);
    if (!groups || groups.length !== 8) return null;
    return groups;
  }

  const head = parseSide(value.slice(0, compressionIndex));
  const tail = parseSide(value.slice(compressionIndex + 2));
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array(missing).fill(0), ...tail];
}

// When the IPv6 address embeds an IPv4 (NAT64 64:ff9b::/96, IPv4-compatible
// ::/96, 6to4 2002::/16, or IPv4-mapped ::ffff:0:0/96), return the embedded
// IPv4 in dotted form so it can be run through the IPv4 blocklist. Otherwise
// null.
function embeddedIpv4FromIpv6(hextets: number[]): string | null {
  const [h0, h1, h2, h3, h4, h5, h6, h7] = hextets as [
    number, number, number, number, number, number, number, number,
  ];
  const toDotted = (hi: number, lo: number): string =>
    `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

  // IPv4-mapped ::ffff:0:0/96 (covers both ::ffff:1.2.3.4 and ::ffff:hhhh:hhhh)
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff) {
    return toDotted(h6, h7);
  }
  // NAT64 64:ff9b::/96
  if (h0 === 0x0064 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
    return toDotted(h6, h7);
  }
  // 6to4 2002::/16 — the 32 bits after 2002: are the embedded IPv4
  if (h0 === 0x2002) {
    return toDotted(h1, h2);
  }
  // IPv4-compatible ::/96 (::a.b.c.d / ::hhhh:hhhh); :: and ::1 fall through to
  // the a===0 rule below, which blocks them either way.
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
    return toDotted(h6, h7);
  }
  return null;
}

function ipv4FromIpv6(value: string): string | null {
  const hextets = ipv6ToHextets(value);
  if (hextets) {
    const embedded = embeddedIpv4FromIpv6(hextets);
    if (embedded) return embedded;
  }
  return ipv4FromMappedIpv6(value);
}

export function isBlockedNotificationResolvedAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const mappedIpv4 = ipv4FromIpv6(normalized);
  const addr = mappedIpv4 ?? normalized;

  if (addr === '::' || addr === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(addr)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(addr)) return true;
  if (/^fe[c-f][0-9a-f]:/i.test(addr)) return true;
  if (/^ff[0-9a-f]{2}:/i.test(addr)) return true;
  if (/^2001:0?db8:/i.test(addr)) return true;

  const parts = ipv4Parts(addr);
  if (!parts) return false;

  const [a, b, c] = parts;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 192 && b === 88 && c === 99) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

export function blockedNotificationWebhookUrlReason(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return 'Webhook URL is not a valid URL';
  }

  if (parsed.protocol !== 'https:') {
    return 'Webhook URL must use HTTPS';
  }

  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_METADATA_HOSTNAMES.has(hostname)) {
    return 'Webhook URL must not point to a metadata endpoint';
  }

  if (isBlockedNotificationResolvedAddress(hostname)) {
    return 'Webhook URL must not point to a private/local address';
  }

  return null;
}

async function resolveDnsJson(hostname: string, recordType: 'A' | 'AAAA'): Promise<string[]> {
  const url = new URL(DNS_JSON_ENDPOINT);
  url.searchParams.set('name', hostname);
  url.searchParams.set('type', recordType);
  const response = await fetch(url, {
    headers: {
      Accept: 'application/dns-json',
      'User-Agent': 'WorldMonitor-Notification-Webhooks/1.0',
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
}

async function defaultResolveHostname(hostname: string): Promise<string[]> {
  const records = await Promise.all([
    resolveDnsJson(hostname, 'A'),
    resolveDnsJson(hostname, 'AAAA'),
  ]);
  return records.flat();
}

/**
 * Fail fast at registration when the webhook hostname currently resolves to a
 * private or reserved address. Delivery repeats this check (and pins its
 * connection) because DNS can change after registration.
 */
export async function assertNotificationWebhookRegistrationUrlSafe(
  rawUrl: string,
  resolveHostname: ResolveHostname = defaultResolveHostname,
): Promise<void> {
  const staticError = blockedNotificationWebhookUrlReason(rawUrl);
  if (staticError) throw new Error(staticError);

  const hostname = new URL(rawUrl).hostname.toLowerCase();
  if (isIpLiteral(hostname)) return;
  let resolvedAddresses: string[];
  try {
    resolvedAddresses = await resolveHostname(hostname);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Webhook URL DNS resolution failed: ${message}`);
  }
  if (!resolvedAddresses.length) throw new Error('Webhook URL DNS resolution returned no addresses');
  if (resolvedAddresses.some(isBlockedNotificationResolvedAddress)) {
    throw new Error('Webhook URL must not point to a private/local address');
  }
}
