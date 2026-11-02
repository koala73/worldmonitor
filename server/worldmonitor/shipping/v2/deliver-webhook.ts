import dns from 'node:dns/promises';
import { createHmac } from 'node:crypto';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';

import {
  isBlockedCallbackUrl,
  isBlockedResolvedAddress,
  type WebhookRecord,
} from './webhook-shared';

export class WebhookDeliverySsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookDeliverySsrfError';
  }
}

export interface WebhookDeliveryPayload {
  subscriberId: string;
  chokepointId: string;
  score: number;
  alertThreshold: number;
  triggeredAt: string;
  reason: string;
  details?: Record<string, unknown>;
}

// `country.risk_surge` delivery body (X-WM-Event: country.risk_surge). The
// registry entry shared/event-triggers.json#events.country.risk_surge and the
// OpenAPI webhooks block mirror this shape; tests/openapi-webhooks-contract
// pins them together.
export interface RiskSurgeWebhookPayload {
  subscriberId: string;
  countryCode: string;
  countryName?: string;
  score: number;
  previousScore?: number | null;
  delta24h: number;
  trend?: string;
  advisoryLevel?: string | null;
  triggeredAt: string;
  reason: string;
  details?: Record<string, unknown>;
}

// `news.breaking` delivery body (X-WM-Event: news.breaking). Built by
// scripts/shipping-webhook-worker.mjs from a teed rss_alert queue message;
// shared/event-triggers.json#events.news.breaking mirrors it and
// tests/openapi-webhooks-contract pins the two together. Every field is
// always present: nullable ones carry null, lists are empty when unknown.
export interface NewsBreakingWebhookPayload {
  subscriberId: string;
  eventId: string;
  title: string;
  source: string;
  link: string | null;
  publishedAt: string;
  severity: string;
  importanceScore: number;
  corroborationCount: number;
  category: string | null;
  countryCodes: string[];
  variant: string | null;
  matchedKeywords: string[];
  triggeredAt: string;
  reason: string;
}

// `market.move` delivery body (X-WM-Event: market.move), from a teed
// market_alert queue message; same pinning as above.
export interface MarketMoveWebhookPayload {
  subscriberId: string;
  eventId: string;
  assetClass: string;
  symbol: string;
  name: string;
  price: number | null;
  changePct: number;
  direction: string;
  severity: string;
  source: string;
  publishedAt: string;
  triggeredAt: string;
  reason: string;
}

// `natural.hazard` delivery body (X-WM-Event: natural.hazard), built by the
// worker from a new row of seismology:earthquakes:v1 or natural:events:v1;
// same pinning as above.
export interface NaturalHazardWebhookPayload {
  subscriberId: string;
  eventId: string;
  hazardType: string;
  title: string;
  source: string;
  sourceUrl: string | null;
  lat: number;
  lon: number;
  countryCodes: string[];
  occurredAt: string;
  magnitude: number | null;
  depthKm: number | null;
  nearTestSite: boolean | null;
  alertLevel: string | null;
  stormName: string | null;
  stormCategory: number | null;
  windKt: number | null;
  triggeredAt: string;
  reason: string;
}

export interface WebhookDeliveryOptions {
  event?: string;
  deliveryId?: string;
  nowMs?: number;
  fetchImpl?: typeof fetch;
  resolveHostname?: (hostname: string) => Promise<string[]>;
}

export interface WebhookDeliveryResult {
  status: number;
  ok: boolean;
  resolvedAddresses: string[];
}

const WEBHOOK_DELIVERY_TIMEOUT_MS = 10_000;
const MAX_WEBHOOK_RESPONSE_BYTES = 1024 * 1024;

async function postJsonWithPinnedAddress(
  url: URL,
  body: string,
  headers: Record<string, string>,
  resolvedAddresses: string[],
): Promise<Pick<Response, 'status' | 'ok'>> {
  const pinnedAddress = resolvedAddresses.find(address => address.includes('.')) ?? resolvedAddresses[0];
  if (!pinnedAddress) {
    throw new WebhookDeliverySsrfError('callbackUrl DNS resolution returned no addresses');
  }
  const family: 4 | 6 = pinnedAddress.includes(':') ? 6 : 4;

  return new Promise((resolve, reject) => {
    let settled = false;
    let response: IncomingMessage | undefined;
    let hardDeadline: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardDeadline);
      req.destroy();
      response?.destroy();
      reject(error);
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
      response = res;
      if (settled) { res.destroy(); return; }
      let totalBytes = 0;
      res.on('error', fail);
      res.on('aborted', () => fail(new Error('webhook response aborted')));
      // Only delivery status is consumed; discard body chunks without buffering.
      res.on('data', chunk => {
        if (settled) return;
        totalBytes += Buffer.byteLength(chunk);
        if (totalBytes > MAX_WEBHOOK_RESPONSE_BYTES) {
          fail(new Error('webhook response too large'));
        }
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(hardDeadline);
        const status = res.statusCode ?? 502;
        resolve({ status, ok: status >= 200 && status < 300 });
      });
    });
    req.on('error', fail);
    req.setTimeout(WEBHOOK_DELIVERY_TIMEOUT_MS, () => {
      fail(new Error('webhook delivery timed out'));
    });
    // Socket activity must not extend the total request lifetime.
    hardDeadline = setTimeout(() => {
      fail(new Error('webhook delivery timed out'));
    }, WEBHOOK_DELIVERY_TIMEOUT_MS);
    req.write(body);
    req.end();
  });
}

async function defaultResolveHostname(hostname: string): Promise<string[]> {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map(record => record.address);
}

function makeDeliveryId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return 'whd_' + [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function assertWebhookDeliveryUrlSafe(
  callbackUrl: string,
  resolveHostname: (hostname: string) => Promise<string[]> = defaultResolveHostname,
): Promise<{ url: URL; resolvedAddresses: string[] }> {
  const urlError = isBlockedCallbackUrl(callbackUrl);
  if (urlError) {
    throw new WebhookDeliverySsrfError(urlError);
  }

  const url = new URL(callbackUrl);
  const hostname = url.hostname.toLowerCase();
  if (isBlockedResolvedAddress(hostname)) {
    throw new WebhookDeliverySsrfError(`callbackUrl resolves to a private/reserved address: ${hostname}`);
  }

  let resolvedAddresses: string[];
  try {
    resolvedAddresses = await resolveHostname(hostname);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WebhookDeliverySsrfError(`callbackUrl DNS resolution failed: ${message}`);
  }

  if (!resolvedAddresses.length) {
    throw new WebhookDeliverySsrfError('callbackUrl DNS resolution returned no addresses');
  }

  const blocked = resolvedAddresses.find(isBlockedResolvedAddress);
  if (blocked) {
    throw new WebhookDeliverySsrfError(`callbackUrl resolves to a private/reserved address: ${blocked}`);
  }

  return { url, resolvedAddresses };
}

export async function deliverShippingV2Webhook(
  record: WebhookRecord,
  payload: WebhookDeliveryPayload | RiskSurgeWebhookPayload,
  options: WebhookDeliveryOptions = {},
): Promise<WebhookDeliveryResult> {
  if (!record.active) {
    throw new Error(`Webhook ${record.subscriberId} is inactive`);
  }

  const { url, resolvedAddresses } = await assertWebhookDeliveryUrlSafe(
    record.callbackUrl,
    options.resolveHostname,
  );
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor((options.nowMs ?? Date.now()) / 1000));
  const deliveryId = options.deliveryId ?? makeDeliveryId();
  const event = options.event ?? 'chokepoint.disruption';
  const signature = createHmac('sha256', record.secret).update(body).digest('hex');
  const signatureV2 = createHmac('sha256', record.secret).update(`${timestamp}.${deliveryId}.${event}.${body}`).digest('hex');
  const headers = {
    'content-type': 'application/json',
    'user-agent': 'WorldMonitor-ShippingV2-Webhooks/1.0',
    'x-wm-signature': `sha256=${signature}`,
    'x-wm-signature-v2': `sha256=${signatureV2}`,
    'x-wm-timestamp': timestamp,
    'x-wm-delivery-id': deliveryId,
    'x-wm-event': event,
  };
  const response = options.fetchImpl
    ? await options.fetchImpl(url, { method: 'POST', headers, body })
    : await postJsonWithPinnedAddress(url, body, headers, resolvedAddresses);

  return {
    status: response.status,
    ok: response.ok,
    resolvedAddresses,
  };
}
