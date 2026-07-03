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

function isBlockedResolvedAddress(address) {
  const normalized = String(address).trim().toLowerCase().replace(/^\[|\]$/g, '');
  const mappedIpv4 = ipv4FromMappedIpv6(normalized);
  const addr = mappedIpv4 || normalized;

  if (addr === '::' || addr === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(addr)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(addr)) return true;
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
      res.on('error', reject);
      res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (!value) continue;
          responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
        }
        resolve(responseFromNode(res.statusCode, res.statusMessage, responseHeaders, Buffer.concat(chunks)));
      });
    });
    req.on('error', reject);
    req.setTimeout(WEBHOOK_DELIVERY_TIMEOUT_MS, () => {
      req.destroy(new Error('webhook delivery timed out'));
    });
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
