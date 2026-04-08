export const config = { runtime: 'edge' };

import { ConvexHttpClient } from 'convex/browser';
import { jsonResponse } from './_json-response.js';

const HANDLED_EVENTS = new Set(['email.bounced', 'email.complained']);

async function verifyWebhookSignature(payload, headers) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return false;

  const msgId = headers.get('svix-id');
  const timestamp = headers.get('svix-timestamp');
  const signature = headers.get('svix-signature');

  if (!msgId || !timestamp || !signature) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const toSign = `${msgId}.${timestamp}.${payload}`;
  const secretBytes = Uint8Array.from(atob(secret.replace('whsec_', '')), c => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    'raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(toSign));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));

  const signatures = signature.split(' ');
  return signatures.some(s => {
    const [, val] = s.split(',');
    return val === expected;
  });
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const rawBody = await req.text();

  const valid = await verifyWebhookSignature(rawBody, req.headers);
  if (!valid) {
    console.warn('[resend-webhook] Invalid signature');
    return jsonResponse({ error: 'Invalid signature' }, 401);
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const eventType = event.type;
  if (!HANDLED_EVENTS.has(eventType)) {
    return jsonResponse({ status: 'ignored', eventType }, 200);
  }

  const recipients = event.data?.to;
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return jsonResponse({ status: 'no_recipients' }, 200);
  }

  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    console.error('[resend-webhook] CONVEX_URL not set');
    return jsonResponse({ error: 'Service unavailable' }, 503);
  }

  const reason = eventType === 'email.bounced' ? 'bounce' : 'complaint';
  const client = new ConvexHttpClient(convexUrl);

  const results = [];
  for (const email of recipients) {
    try {
      await client.mutation('emailSuppressions:suppress', {
        email,
        reason,
        source: `resend-webhook:${event.data?.email_id || 'unknown'}`,
      });
      results.push({ email, suppressed: true });
      console.log(`[resend-webhook] Suppressed ${email} (${reason})`);
    } catch (err) {
      console.error(`[resend-webhook] Failed to suppress ${email}:`, err);
      results.push({ email, suppressed: false, error: err.message });
    }
  }

  return jsonResponse({ status: 'processed', results }, 200);
}
