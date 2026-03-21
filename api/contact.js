export const config = { runtime: 'edge' };

import { ConvexHttpClient } from 'convex/browser';
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { getClientIp, verifyTurnstile } from './_turnstile.js';
import { jsonResponse } from './_json-response.js';
import { createIpRateLimiter } from './_ip-rate-limit.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[+(]?\d[\d\s()./-]{4,23}\d$/;
const MAX_FIELD = 500;
const MAX_MESSAGE = 2000;

const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.fr', 'yahoo.co.uk', 'yahoo.co.jp',
  'hotmail.com', 'hotmail.fr', 'hotmail.co.uk', 'outlook.com', 'outlook.fr',
  'live.com', 'live.fr', 'msn.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com',
  'protonmail.com', 'proton.me', 'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru',
  'gmx.com', 'gmx.net', 'gmx.de', 'web.de', 'mail.ru', 'inbox.com',
  'fastmail.com', 'tutanota.com', 'tuta.io', 'hey.com',
  'qq.com', '163.com', '126.com', 'sina.com', 'foxmail.com',
  'rediffmail.com', 'ymail.com', 'rocketmail.com',
  'wanadoo.fr', 'free.fr', 'laposte.net', 'orange.fr', 'sfr.fr',
  't-online.de', 'libero.it', 'virgilio.it',
]);

const RATE_LIMIT = 3;
const RATE_WINDOW_MS = 60 * 60 * 1000;

const rateLimiter = createIpRateLimiter({ limit: RATE_LIMIT, windowMs: RATE_WINDOW_MS });

async function sendNotificationEmail(name, email, organization, phone, message) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.error('[contact] RESEND_API_KEY not set — lead stored in Convex but notification NOT sent');
    return false;
  }
  const notifyEmail = process.env.CONTACT_NOTIFY_EMAIL || 'elie.habib@gmail.com';
  const emailDomain = (email.split('@')[1] || '').toLowerCase();
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${resendKey}`,
      },
      body: JSON.stringify({
        from: 'World Monitor <noreply@worldmonitor.app>',
        to: [notifyEmail],
        subject: `[WM Enterprise] ${sanitizeForSubject(name)} from ${sanitizeForSubject(organization)}`,
        html: `
          <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #4ade80;">New Enterprise Contact</h2>
            <table style="width: 100%; border-collapse: collapse;">
              <tr><td style="padding: 8px; font-weight: bold; color: #666;">Name</td><td style="padding: 8px;">${escapeHtml(name)}</td></tr>
              <tr><td style="padding: 8px; font-weight: bold; color: #666;">Email</td><td style="padding: 8px;"><a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></td></tr>
              <tr><td style="padding: 8px; font-weight: bold; color: #666;">Domain</td><td style="padding: 8px;"><a href="https://${escapeHtml(emailDomain)}" target="_blank">${escapeHtml(emailDomain)}</a></td></tr>
              <tr><td style="padding: 8px; font-weight: bold; color: #666;">Company</td><td style="padding: 8px;">${escapeHtml(organization)}</td></tr>
              <tr><td style="padding: 8px; font-weight: bold; color: #666;">Phone</td><td style="padding: 8px;"><a href="tel:${escapeHtml(phone)}">${escapeHtml(phone)}</a></td></tr>
              <tr><td style="padding: 8px; font-weight: bold; color: #666;">Message</td><td style="padding: 8px;">${escapeHtml(message || 'N/A')}</td></tr>
            </table>
            <p style="color: #999; font-size: 12px; margin-top: 24px;">Sent from worldmonitor.app enterprise contact form</p>
          </div>`,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[contact] Resend ${res.status}:`, body);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[contact] Resend error:', err);
    return false;
  }
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sanitizeForSubject(str, maxLen = 50) {
  return str.replace(/[\r\n\0]/g, '').slice(0, maxLen);
}

export default async function handler(req) {
  if (isDisallowedOrigin(req)) {
    return jsonResponse({ error: 'Origin not allowed' }, 403);
  }

  const cors = getCorsHeaders(req, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  const ip = getClientIp(req);

  if (rateLimiter.isRateLimited(ip)) {
    return jsonResponse({ error: 'Too many requests' }, 429, cors);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400, cors);
  }

  if (body.website) {
    return jsonResponse({ status: 'sent' }, 200, cors);
  }

  const turnstileOk = await verifyTurnstile({
    token: body.turnstileToken || '',
    ip,
    logPrefix: '[contact]',
    missingSecretPolicy: 'allow-in-development',
  });
  if (!turnstileOk) {
    return jsonResponse({ error: 'Bot verification failed' }, 403, cors);
  }

  const { email, name, organization, phone, message, source } = body;

  if (!email || typeof email !== 'string' || !EMAIL_RE.test(email)) {
    return jsonResponse({ error: 'Invalid email' }, 400, cors);
  }

  const emailDomain = email.split('@')[1]?.toLowerCase();
  if (emailDomain && FREE_EMAIL_DOMAINS.has(emailDomain)) {
    return jsonResponse({ error: 'Please use your work email address' }, 422, cors);
  }

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return jsonResponse({ error: 'Name is required' }, 400, cors);
  }
  if (!organization || typeof organization !== 'string' || organization.trim().length === 0) {
    return jsonResponse({ error: 'Company is required' }, 400, cors);
  }
  if (!phone || typeof phone !== 'string' || !PHONE_RE.test(phone.trim())) {
    return jsonResponse({ error: 'Valid phone number is required' }, 400, cors);
  }

  const safeName = name.slice(0, MAX_FIELD);
  const safeOrg = organization.slice(0, MAX_FIELD);
  const safePhone = phone.trim().slice(0, 30);
  const safeMsg = typeof message === 'string' ? message.slice(0, MAX_MESSAGE) : undefined;
  const safeSource = typeof source === 'string' ? source.slice(0, 100) : 'enterprise-contact';

  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    return jsonResponse({ error: 'Service unavailable' }, 503, cors);
  }

  try {
    const client = new ConvexHttpClient(convexUrl);
    await client.mutation('contactMessages:submit', {
      name: safeName,
      email: email.trim(),
      organization: safeOrg,
      phone: safePhone,
      message: safeMsg,
      source: safeSource,
    });

    const emailSent = await sendNotificationEmail(safeName, email.trim(), safeOrg, safePhone, safeMsg);

    return jsonResponse({ status: 'sent', emailSent }, 200, cors);
  } catch (err) {
    console.error('[contact] error:', err);
    return jsonResponse({ error: 'Failed to send message' }, 500, cors);
  }
}
