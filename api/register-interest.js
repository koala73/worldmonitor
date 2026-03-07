export const config = { runtime: 'edge' };

import { ConvexHttpClient } from 'convex/browser';
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 320;
const MAX_META_LENGTH = 100;

const rateLimitMap = new Map();
const RATE_LIMIT = 5;
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
  if (!secret) return true; // skip if not configured
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

async function sendConfirmationEmail(email, referralCode) {
  const referralLink = `https://worldmonitor.app/pro?ref=${referralCode}`;
  const shareText = encodeURIComponent('I just joined the World Monitor Pro waitlist \u2014 real-time global intelligence powered by AI. Join me:');
  const shareUrl = encodeURIComponent(referralLink);
  const twitterShare = `https://x.com/intent/tweet?text=${shareText}&url=${shareUrl}`;
  const linkedinShare = `https://www.linkedin.com/sharing/share-offsite/?url=${shareUrl}`;
  const whatsappShare = `https://wa.me/?text=${shareText}%20${shareUrl}`;
  const telegramShare = `https://t.me/share/url?url=${shareUrl}&text=${encodeURIComponent('Join the World Monitor Pro waitlist:')}`;

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.warn('[register-interest] RESEND_API_KEY not set — skipping email');
    return;
  }
  try {
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${resendKey}`,
      },
      body: JSON.stringify({
        from: 'World Monitor <noreply@worldmonitor.app>',
        to: [email],
        subject: 'You\u2019re on the World Monitor Pro waitlist',
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; background: #0a0a0a; color: #e0e0e0;">
            <div style="background: #4ade80; height: 4px;"></div>
            <div style="padding: 40px 32px 0;">
              <table cellpadding="0" cellspacing="0" border="0" style="margin: 0 auto 32px;">
                <tr>
                  <td style="width: 40px; height: 40px; border-radius: 50%; border: 1px solid #222; text-align: center; vertical-align: middle; background: #111;">
                    <span style="font-size: 20px; color: #4ade80;">&#9678;</span>
                  </td>
                  <td style="padding-left: 12px;">
                    <div style="font-size: 16px; font-weight: 800; color: #fff; letter-spacing: -0.5px;">WORLD MONITOR</div>
                    <div style="font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 2px;">by Someone.ceo</div>
                  </td>
                </tr>
              </table>
              <div style="background: #111; border: 1px solid #1a1a1a; border-left: 3px solid #4ade80; padding: 20px 24px; margin-bottom: 28px;">
                <p style="font-size: 18px; font-weight: 600; color: #fff; margin: 0 0 8px;">You\u2019re on the Pro waitlist.</p>
                <p style="font-size: 14px; color: #999; margin: 0; line-height: 1.5;">We\u2019ll notify you the moment Pro launches. Here\u2019s what you\u2019ll get:</p>
              </div>
              <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom: 28px;">
                <tr>
                  <td style="width: 50%; padding: 12px; vertical-align: top;">
                    <div style="background: #111; border: 1px solid #1a1a1a; padding: 16px; height: 100%;">
                      <div style="font-size: 20px; margin-bottom: 8px;">&#9889;</div>
                      <div style="font-size: 13px; font-weight: 700; color: #fff; margin-bottom: 4px;">Near-Real-Time</div>
                      <div style="font-size: 12px; color: #888; line-height: 1.4;">Data refresh under 60 seconds via priority pipeline</div>
                    </div>
                  </td>
                  <td style="width: 50%; padding: 12px; vertical-align: top;">
                    <div style="background: #111; border: 1px solid #1a1a1a; padding: 16px; height: 100%;">
                      <div style="font-size: 20px; margin-bottom: 8px;">&#129504;</div>
                      <div style="font-size: 13px; font-weight: 700; color: #fff; margin-bottom: 4px;">AI Analyst</div>
                      <div style="font-size: 12px; color: #888; line-height: 1.4;">Morning briefs, flash alerts, pattern detection</div>
                    </div>
                  </td>
                </tr>
                <tr>
                  <td style="width: 50%; padding: 12px; vertical-align: top;">
                    <div style="background: #111; border: 1px solid #1a1a1a; padding: 16px; height: 100%;">
                      <div style="font-size: 20px; margin-bottom: 8px;">&#128232;</div>
                      <div style="font-size: 13px; font-weight: 700; color: #fff; margin-bottom: 4px;">Delivered to You</div>
                      <div style="font-size: 12px; color: #888; line-height: 1.4;">Slack, Telegram, WhatsApp, Email, Discord</div>
                    </div>
                  </td>
                  <td style="width: 50%; padding: 12px; vertical-align: top;">
                    <div style="background: #111; border: 1px solid #1a1a1a; padding: 16px; height: 100%;">
                      <div style="font-size: 20px; margin-bottom: 8px;">&#128273;</div>
                      <div style="font-size: 13px; font-weight: 700; color: #fff; margin-bottom: 4px;">22 Services, 1 Key</div>
                      <div style="font-size: 12px; color: #888; line-height: 1.4;">ACLED, NASA FIRMS, OpenSky, Finnhub, and more</div>
                    </div>
                  </td>
                </tr>
              </table>
              <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom: 28px; background: #111; border: 1px solid #1a1a1a;">
                <tr>
                  <td style="text-align: center; padding: 16px 8px; width: 33%;">
                    <div style="font-size: 22px; font-weight: 800; color: #4ade80;">2M+</div>
                    <div style="font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 1px;">Users</div>
                  </td>
                  <td style="text-align: center; padding: 16px 8px; width: 33%; border-left: 1px solid #1a1a1a; border-right: 1px solid #1a1a1a;">
                    <div style="font-size: 22px; font-weight: 800; color: #4ade80;">435+</div>
                    <div style="font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 1px;">Sources</div>
                  </td>
                  <td style="text-align: center; padding: 16px 8px; width: 33%;">
                    <div style="font-size: 22px; font-weight: 800; color: #4ade80;">190+</div>
                    <div style="font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 1px;">Countries</div>
                  </td>
                </tr>
              </table>
              <div style="text-align: center; margin-bottom: 24px;">
                <div style="display: inline-block; background: #111; border: 1px solid #4ade80; padding: 12px 28px;">
                  <div style="font-size: 18px; font-weight: 800; color: #fff;">You're in!</div>
                  <div style="font-size: 11px; color: #4ade80; text-transform: uppercase; letter-spacing: 2px; margin-top: 4px;">Waitlist confirmed</div>
                </div>
              </div>
              <div style="background: #111; border: 1px solid #1a1a1a; border-left: 3px solid #4ade80; padding: 20px 24px; margin-bottom: 24px;">
                <p style="font-size: 16px; font-weight: 700; color: #fff; margin: 0 0 8px;">Move up the line \u2014 invite friends</p>
                <p style="font-size: 13px; color: #888; margin: 0 0 16px; line-height: 1.5;">Each friend who joins through your link bumps you closer to the front. Top referrers get early access.</p>
                <div style="background: #0a0a0a; border: 1px solid #222; padding: 12px 16px; margin-bottom: 16px; word-break: break-all;">
                  <a href="${referralLink}" style="color: #4ade80; text-decoration: none; font-size: 13px; font-family: monospace;">${referralLink}</a>
                </div>
                <table cellpadding="0" cellspacing="0" border="0" width="100%">
                  <tr>
                    <td style="width: 25%; text-align: center; padding: 4px;">
                      <a href="${twitterShare}" style="display: inline-block; background: #1a1a1a; border: 1px solid #222; color: #ccc; text-decoration: none; padding: 8px 0; width: 100%; font-size: 11px; font-weight: 600;">X</a>
                    </td>
                    <td style="width: 25%; text-align: center; padding: 4px;">
                      <a href="${linkedinShare}" style="display: inline-block; background: #1a1a1a; border: 1px solid #222; color: #ccc; text-decoration: none; padding: 8px 0; width: 100%; font-size: 11px; font-weight: 600;">LinkedIn</a>
                    </td>
                    <td style="width: 25%; text-align: center; padding: 4px;">
                      <a href="${whatsappShare}" style="display: inline-block; background: #1a1a1a; border: 1px solid #222; color: #ccc; text-decoration: none; padding: 8px 0; width: 100%; font-size: 11px; font-weight: 600;">WhatsApp</a>
                    </td>
                    <td style="width: 25%; text-align: center; padding: 4px;">
                      <a href="${telegramShare}" style="display: inline-block; background: #1a1a1a; border: 1px solid #222; color: #ccc; text-decoration: none; padding: 8px 0; width: 100%; font-size: 11px; font-weight: 600;">Telegram</a>
                    </td>
                  </tr>
                </table>
              </div>
              <div style="text-align: center; margin-bottom: 36px;">
                <a href="https://worldmonitor.app" style="display: inline-block; background: #4ade80; color: #0a0a0a; padding: 14px 36px; text-decoration: none; font-weight: 800; font-size: 13px; text-transform: uppercase; letter-spacing: 1.5px; border-radius: 2px;">Explore the Free Dashboard</a>
                <p style="font-size: 12px; color: #555; margin-top: 12px;">The free dashboard stays free forever. Pro adds intelligence on top.</p>
              </div>
            </div>
            <div style="border-top: 1px solid #1a1a1a; padding: 24px 32px; text-align: center;">
              <div style="margin-bottom: 16px;">
                <a href="https://x.com/eliehabib" style="color: #666; text-decoration: none; font-size: 12px; margin: 0 12px;">X / Twitter</a>
                <a href="https://github.com/koala73/worldmonitor" style="color: #666; text-decoration: none; font-size: 12px; margin: 0 12px;">GitHub</a>
                <a href="https://worldmonitor.app/pro" style="color: #666; text-decoration: none; font-size: 12px; margin: 0 12px;">Pro Waitlist</a>
              </div>
              <p style="font-size: 11px; color: #444; margin: 0; line-height: 1.6;">
                World Monitor \u2014 Real-time intelligence for a connected world.<br />
                <a href="https://worldmonitor.app" style="color: #4ade80; text-decoration: none;">worldmonitor.app</a>
              </p>
            </div>
          </div>`,
      }),
    });
    if (!resendRes.ok) {
      const body = await resendRes.text();
      console.error(`[register-interest] Resend ${resendRes.status}:`, body);
    } else {
      console.log(`[register-interest] Email sent to ${email}`);
    }
  } catch (err) {
    console.error('[register-interest] Resend error:', err);
  }
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

  // x-real-ip is injected by Vercel from the TCP connection and cannot be spoofed.
  // x-forwarded-for is client-settable — only use as last resort.
  const ip =
    req.headers.get('x-real-ip') ||
    req.headers.get('cf-connecting-ip') ||
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

  // Honeypot — bots auto-fill this hidden field; real users leave it empty
  if (body.website) {
    return new Response(JSON.stringify({ status: 'registered' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  // Cloudflare Turnstile verification — skip for desktop app (no browser captcha available).
  // Desktop bypasses captcha, so enforce stricter rate limit (2/hr vs 5/hr).
  const DESKTOP_SOURCES = new Set(['desktop-settings']);
  const isDesktopSource = typeof body.source === 'string' && DESKTOP_SOURCES.has(body.source);
  if (isDesktopSource) {
    const entry = rateLimitMap.get(ip);
    if (entry && entry.count > 2) {
      return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
  } else {
    const turnstileOk = await verifyTurnstile(body.turnstileToken || '', ip);
    if (!turnstileOk) {
      return new Response(JSON.stringify({ error: 'Bot verification failed' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
  }

  const { email, source, appVersion, referredBy } = body;
  if (!email || typeof email !== 'string' || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
    return new Response(JSON.stringify({ error: 'Invalid email address' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  const safeSource = typeof source === 'string'
    ? source.slice(0, MAX_META_LENGTH)
    : 'unknown';
  const safeAppVersion = typeof appVersion === 'string'
    ? appVersion.slice(0, MAX_META_LENGTH)
    : 'unknown';
  const safeReferredBy = typeof referredBy === 'string'
    ? referredBy.slice(0, 20)
    : undefined;

  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    return new Response(JSON.stringify({ error: 'Registration service unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  try {
    const client = new ConvexHttpClient(convexUrl);
    const result = await client.mutation('registerInterest:register', {
      email,
      source: safeSource,
      appVersion: safeAppVersion,
      referredBy: safeReferredBy,
    });

    // Send confirmation email for new registrations (awaited to avoid Edge isolate termination)
    if (result.status === 'registered' && result.referralCode) {
      await sendConfirmationEmail(email, result.referralCode);
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  } catch (err) {
    console.error('[register-interest] Convex error:', err);
    return new Response(JSON.stringify({ error: 'Registration failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }
}
