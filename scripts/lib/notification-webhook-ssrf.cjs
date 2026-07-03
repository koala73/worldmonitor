'use strict';

const dns = require('node:dns').promises;
const https = require('node:https');

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

const WEBHOOK_DELIVERY_TIMEOUT_MS = 10_000;
const MAX_WEBHOOK_RESPONSE_BYTES = 1024 * 1024;

class NotificationWebhookSsrfError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotificationWebhookSsrfError';
  }
}

function ipv4Parts(value) {
  const parts = String(value).split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map(part => Number(part));
  if (nums.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return nums;
}

function ipv4FromMappedIpv6(value) {
  const dotted = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (dotted && ipv4Parts(dotted[1])) return dotted[1];

  const hex = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hex) return null;
  const hi = Number.parseInt(hex[1], 16);
  const lo = Number.parseInt(hex[2], 16);
  if (!Number.isInteger(hi) || !Number.isInteger(lo) || hi < 0 || hi > 0xffff || lo < 0 || lo > 0xffff) {
    return null;
  }
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

// Parse an IPv6 literal (compressed or expanded, any case, optional trailing
// dotted IPv4) into exactly eight 16-bit hextets, or null when it is not a
// syntactically valid IPv6 address.
function ipv6ToHextets(value) {
  if (typeof value !== 'string' || !value.includes(':')) return null;
  if ((value.match(/::/g) || []).length > 1) return null;

  const parseSide = (side) => {
    if (side === '') return [];
    const tokens = side.split(':');
    const hextets = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
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
function embeddedIpv4FromIpv6(hextets) {
  const [h0, h1, h2, h3, h4, h5, h6, h7] = hextets;
  const toDotted = (hi, lo) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

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

function ipv4FromIpv6(value) {
  const hextets = ipv6ToHextets(value);
  if (hextets) {
    const embedded = embeddedIpv4FromIpv6(hextets);
    if (embedded) return embedded;
  }
  return ipv4FromMappedIpv6(value);
}

function isBlockedResolvedAddress(address) {
  const normalized = String(address).trim().toLowerCase().replace(/^\[|\]$/g, '');
  const mappedIpv4 = ipv4FromIpv6(normalized);
  const addr = mappedIpv4 || normalized;

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

function blockedNotificationWebhookUrlReason(rawUrl) {
  let parsed;
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

  if (isBlockedResolvedAddress(hostname)) {
    return 'Webhook URL must not point to a private/local address';
  }

  return null;
}

async function defaultResolveHostname(hostname) {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map(record => record.address);
}

async function assertNotificationWebhookDeliveryUrlSafe(rawUrl, resolveHostname = defaultResolveHostname) {
  const urlError = blockedNotificationWebhookUrlReason(rawUrl);
  if (urlError) {
    throw new NotificationWebhookSsrfError(urlError);
  }

  const url = new URL(rawUrl);
  let resolvedAddresses;
  try {
    resolvedAddresses = await resolveHostname(url.hostname);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new NotificationWebhookSsrfError(`Webhook URL DNS resolution failed: ${message}`);
  }

  if (!resolvedAddresses.length) {
    throw new NotificationWebhookSsrfError('Webhook URL DNS resolution returned no addresses');
  }

  const blocked = resolvedAddresses.find(isBlockedResolvedAddress);
  if (blocked) {
    throw new NotificationWebhookSsrfError(`Webhook URL resolves to a private/reserved address: ${blocked}`);
  }

  return { url, resolvedAddresses };
}

function responseFromNode(statusCode, statusMessage, headers, body) {
  return new Response(new Uint8Array(body), {
    status: statusCode || 502,
    statusText: statusMessage,
    headers,
  });
}

async function postJsonWithPinnedAddress(url, body, headers, resolvedAddresses) {
  const pinnedAddress = resolvedAddresses.find(address => address.includes('.')) || resolvedAddresses[0];
  if (!pinnedAddress) {
    throw new NotificationWebhookSsrfError('Webhook URL DNS resolution returned no addresses');
  }
  if (isBlockedResolvedAddress(pinnedAddress)) {
    throw new NotificationWebhookSsrfError(`Webhook URL resolves to a private/reserved address: ${pinnedAddress}`);
  }
  const family = pinnedAddress.includes(':') ? 6 : 4;

  return new Promise((resolve, reject) => {
    let settled = false;
    let hardDeadline;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (hardDeadline) clearTimeout(hardDeadline);
      fn(value);
    };
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        ...headers,
        'content-length': String(Buffer.byteLength(body)),
      },
      family,
      lookup: (_hostname, _options, callback) => callback(null, pinnedAddress, family),
    }, (res) => {
      const chunks = [];
      let totalBytes = 0;
      res.on('error', error => settle(reject, error));
      res.on('data', chunk => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.length;
        if (totalBytes > MAX_WEBHOOK_RESPONSE_BYTES) {
          req.destroy(new Error('webhook response too large'));
          return;
        }
        chunks.push(buffer);
      });
      res.on('end', () => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (!value) continue;
          responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
        }
        settle(resolve, responseFromNode(res.statusCode, res.statusMessage, responseHeaders, Buffer.concat(chunks)));
      });
    });
    req.on('error', error => settle(reject, error));
    req.setTimeout(WEBHOOK_DELIVERY_TIMEOUT_MS, () => {
      req.destroy(new Error('webhook delivery timed out'));
    });
    hardDeadline = setTimeout(() => {
      req.destroy(new Error('webhook delivery timed out'));
    }, WEBHOOK_DELIVERY_TIMEOUT_MS);
    req.write(body);
    req.end();
  });
}

module.exports = {
  NotificationWebhookSsrfError,
  assertNotificationWebhookDeliveryUrlSafe,
  blockedNotificationWebhookUrlReason,
  isBlockedResolvedAddress,
  postJsonWithPinnedAddress,
};
