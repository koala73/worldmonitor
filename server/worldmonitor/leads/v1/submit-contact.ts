/**
 * RPC: submitContact -- Stores an enterprise contact submission and emails ops.
 * Port from api/contact.js
 * Sources: Convex contactMessages:submit mutation + Resend notification email
 */

import { ConvexHttpClient } from 'convex/browser';
import type {
  ServerContext,
  SubmitContactRequest,
  SubmitContactResponse,
} from '../../../../src/generated/server/worldmonitor/leads/v1/service_server';
import { ApiError, ValidationError } from '../../../../src/generated/server/worldmonitor/leads/v1/service_server';
import { getClientIp, verifyTurnstile } from '../../../_shared/turnstile';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[+(]?\d[\d\s()./-]{4,23}\d$/;
const MAX_FIELD = 500;
const MAX_MESSAGE = 2000;

const FREE_EMAIL_DOMAINS = new Set<string>([
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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sanitizeForSubject(str: string, maxLen = 50): string {
  return str.replace(/[\r\n\0]/g, '').slice(0, maxLen);
}

async function sendNotificationEmail(
  name: string,
  email: string,
  organization: string,
  phone: string,
  message: string | undefined,
  ip: string,
  country: string | null,
): Promise<boolean> {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.error('[contact] RESEND_API_KEY not set — lead stored in Convex but notification NOT sent');
    return false;
  }
  const notifyEmail = process.env.CONTACT_NOTIFY_EMAIL || 'elie@worldmonitor.app';
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
              <tr><td style="padding: 8px; font-weight: bold; color: #666;">IP</td><td style="padding: 8px; font-family: monospace;">${escapeHtml(ip || 'unknown')}</td></tr>
              ${country ? `<tr><td style="padding: 8px; font-weight: bold; color: #666;">Country</td><td style="padding: 8px;">${escapeHtml(country)}</td></tr>` : ''}
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

export async function submitContact(
  ctx: ServerContext,
  req: SubmitContactRequest,
): Promise<SubmitContactResponse> {
  // Honeypot — silently accept but do nothing (bots auto-fill hidden field).
  if (req.website) {
    return { status: 'sent', emailSent: false };
  }

  const ip = getClientIp(ctx.request);
  const country = ctx.request.headers.get('cf-ipcountry')
    || ctx.request.headers.get('x-vercel-ip-country');

  const turnstileOk = await verifyTurnstile({
    token: req.turnstileToken || '',
    ip,
    logPrefix: '[contact]',
  });
  if (!turnstileOk) {
    throw new ApiError(403, 'Bot verification failed', '');
  }

  const { email, name, organization, phone, message, source } = req;

  if (!email || !EMAIL_RE.test(email)) {
    throw new ValidationError([{ field: 'email', description: 'Invalid email' }]);
  }

  const emailDomain = email.split('@')[1]?.toLowerCase();
  if (emailDomain && FREE_EMAIL_DOMAINS.has(emailDomain)) {
    throw new ApiError(422, 'Please use your work email address', '');
  }

  if (!name || name.trim().length === 0) {
    throw new ValidationError([{ field: 'name', description: 'Name is required' }]);
  }
  if (!organization || organization.trim().length === 0) {
    throw new ValidationError([{ field: 'organization', description: 'Company is required' }]);
  }
  if (!phone || !PHONE_RE.test(phone.trim())) {
    throw new ValidationError([{ field: 'phone', description: 'Valid phone number is required' }]);
  }

  const safeName = name.slice(0, MAX_FIELD);
  const safeOrg = organization.slice(0, MAX_FIELD);
  const safePhone = phone.trim().slice(0, 30);
  const safeMsg = message ? message.slice(0, MAX_MESSAGE) : undefined;
  const safeSource = source ? source.slice(0, 100) : 'enterprise-contact';

  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    throw new ApiError(503, 'Service unavailable', '');
  }

  const client = new ConvexHttpClient(convexUrl);
  await client.mutation('contactMessages:submit' as any, {
    name: safeName,
    email: email.trim(),
    organization: safeOrg,
    phone: safePhone,
    message: safeMsg,
    source: safeSource,
  });

  const emailSent = await sendNotificationEmail(
    safeName,
    email.trim(),
    safeOrg,
    safePhone,
    safeMsg,
    ip,
    country,
  );

  return { status: 'sent', emailSent };
}
