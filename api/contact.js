export const config = { runtime: 'edge' };

import { ConvexHttpClient } from 'convex/browser';
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';

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

const rateLimitMap = new Map();
const RATE_LIMIT = 3;
const RATE_WINDOW_MS = 60 * 60 * 1000;

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    rateLimitMap.set(ip, { windowStart: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT;
}

async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    const isLocal = (process.env.VERCEL_ENV ?? 'development') === 'development';
    if (!isLocal) {
      console.error('[contact] TURNSTILE_SECRET_KEY not set in production, rejecting');
      return false;
    }
    return true;
  }
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, remoteip: ip }),
    });
    const data = await res.json();
    return data.success === true;
  } catch {
    return false;
  }
}

async function sendNotificationEmail(name, email, organization, phone, message) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.error('[contact] RESEND_API_KEY not set — lead stored in Convex but notification NOT sent');
    return false;
  }
  const notifyEmail = process.env.CONTACT_NOTIFY_EMAIL || 'sales@worldmonitor.app';
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
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const cors = getCorsHeaders(req, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  const ip =
    req.headers.get('cf-connecting-ip') ||
    req.headers.get('x-real-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown';

  if (isRateLimited(ip)) {
    return new Response(JSON.stringify({ error: 'Too many requests' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  if (body.website) {
    return new Response(JSON.stringify({ status: 'sent' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  const turnstileOk = await verifyTurnstile(body.turnstileToken || '', ip);
  if (!turnstileOk) {
    return new Response(JSON.stringify({ error: 'Bot verification failed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  const { email, name, organization, phone, message, source } = body;

  if (!email || typeof email !== 'string' || !EMAIL_RE.test(email)) {
    return new Response(JSON.stringify({ error: 'Invalid email' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  const emailDomain = email.split('@')[1]?.toLowerCase();
  if (emailDomain && FREE_EMAIL_DOMAINS.has(emailDomain)) {
    return new Response(JSON.stringify({ error: 'Please use your work email address' }), {
      status: 422,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return new Response(JSON.stringify({ error: 'Name is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }
  if (!organization || typeof organization !== 'string' || organization.trim().length === 0) {
    return new Response(JSON.stringify({ error: 'Company is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }
  if (!phone || typeof phone !== 'string' || !PHONE_RE.test(phone.trim())) {
    return new Response(JSON.stringify({ error: 'Valid phone number is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  const safeName = name.slice(0, MAX_FIELD);
  const safeOrg = organization.slice(0, MAX_FIELD);
  const safePhone = phone.trim().slice(0, 30);
  const safeMsg = typeof message === 'string' ? message.slice(0, MAX_MESSAGE) : undefined;
  const safeSource = typeof source === 'string' ? source.slice(0, 100) : 'enterprise-contact';

  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    return new Response(JSON.stringify({ error: 'Service unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
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

    return new Response(JSON.stringify({ status: 'sent', emailSent }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  } catch (err) {
    console.error('[contact] error:', err);
    return new Response(JSON.stringify({ error: 'Failed to send message' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }
}
