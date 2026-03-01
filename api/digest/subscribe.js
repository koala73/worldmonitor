export const config = { runtime: 'edge' };

import { ConvexHttpClient } from 'convex/browser';
import { getCorsHeaders, isDisallowedOrigin } from '../_cors.js';
import { checkRateLimit } from '../_rate-limit.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 320;
const VALID_FREQUENCIES = ['hourly', '2h', '6h', 'daily', 'weekly', 'monthly'];
const VALID_VARIANTS = ['full', 'tech', 'finance', 'happy'];

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

    // Rate limit check
    const rateLimited = await checkRateLimit(req, cors);
    if (rateLimited) return rateLimited;

    let body;
    try {
        body = await req.json();
    } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...cors },
        });
    }

    const { email, frequency, variant, lang, categories } = body;

    // Validate email
    if (!email || typeof email !== 'string' || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
        return new Response(JSON.stringify({ error: 'Invalid email address' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...cors },
        });
    }

    // Validate frequency
    if (!frequency || !VALID_FREQUENCIES.includes(frequency)) {
        return new Response(JSON.stringify({ error: 'Invalid frequency' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...cors },
        });
    }

    // Validate variant
    if (!variant || !VALID_VARIANTS.includes(variant)) {
        return new Response(JSON.stringify({ error: 'Invalid variant' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...cors },
        });
    }

    // Validate categories
    if (!Array.isArray(categories) || categories.length === 0) {
        return new Response(JSON.stringify({ error: 'At least one category required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...cors },
        });
    }

    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl) {
        return new Response(JSON.stringify({ error: 'Service unavailable' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json', ...cors },
        });
    }

    try {
        const client = new ConvexHttpClient(convexUrl);
        const result = await client.mutation('digestSubscriptions:subscribe', {
            email,
            frequency,
            variant: variant || 'full',
            lang: lang || 'en',
            categories,
        });

        // Send confirmation email for new or pending subscriptions
        if (result.status === 'subscribed' || result.status === 'pending') {
            await sendConfirmationEmail(email, result.token);
        }

        return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'Content-Type': 'application/json', ...cors },
        });
    } catch (err) {
        console.error('[digest/subscribe] Error:', err);
        return new Response(JSON.stringify({ error: 'Subscription failed' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...cors },
        });
    }
}

async function sendConfirmationEmail(email, token) {
    const resendKey = process.env.RESEND_API_KEY;
    const fromEmail = process.env.DIGEST_FROM_EMAIL || 'digest@worldmonitor.app';
    if (!resendKey) {
        console.warn('[digest/subscribe] RESEND_API_KEY not set, skipping confirmation email');
        return;
    }

    const confirmUrl = `https://worldmonitor.app/api/digest/confirm?token=${token}`;
    const manageUrl = `https://worldmonitor.app/api/digest/manage?token=${token}`;

    const html = `
    <div style="background:#0a0a0a;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,monospace;padding:40px 20px;text-align:center;">
      <div style="max-width:500px;margin:0 auto;">
        <h1 style="color:#44ff88;font-size:24px;margin-bottom:8px;">World Monitor</h1>
        <p style="color:#888;font-size:14px;margin-bottom:32px;">Email Digest</p>
        <p style="font-size:16px;margin-bottom:24px;">Confirm your digest subscription</p>
        <p style="color:#aaa;font-size:14px;margin-bottom:32px;">Click the button below to confirm and start receiving AI-generated news digests.</p>
        <a href="${confirmUrl}" style="display:inline-block;background:#44ff88;color:#0a0a0a;text-decoration:none;padding:14px 32px;border-radius:6px;font-weight:700;font-size:14px;letter-spacing:0.5px;">CONFIRM SUBSCRIPTION</a>
        <p style="color:#666;font-size:12px;margin-top:32px;">
          If you didn't request this, you can safely ignore this email.<br>
          <a href="${manageUrl}" style="color:#44ff88;text-decoration:none;">Manage preferences</a>
        </p>
      </div>
    </div>
  `;

    try {
        await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${resendKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from: `World Monitor <${fromEmail}>`,
                to: [email],
                subject: 'Confirm your World Monitor digest subscription',
                html,
            }),
        });
    } catch (err) {
        console.error('[digest/subscribe] Failed to send confirmation email:', err);
    }
}
