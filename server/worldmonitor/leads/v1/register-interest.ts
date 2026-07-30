/**
 * RPC: registerInterest -- Adds an email to the Pro waitlist and emails a confirmation.
 * Port from api/register-interest.js
 * Sources: Convex registerInterest:register mutation + Resend confirmation email
 */

import { ConvexHttpClient } from 'convex/browser';
import type {
  ServerContext,
  RegisterInterestRequest,
  RegisterInterestResponse,
} from '../../../../src/generated/server/worldmonitor/leads/v1/service_server';
import { ApiError, ValidationError } from '../../../../src/generated/server/worldmonitor/leads/v1/service_server';
import { getClientIp, verifyTurnstile } from '../../../_shared/turnstile';
import { validateEmail } from '../../../_shared/email-validation';
import { checkScopedRateLimit } from '../../../_shared/rate-limit';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 320;
const MAX_META_LENGTH = 100;

const DESKTOP_SOURCES = new Set<string>(['desktop-settings']);
export const DESKTOP_AUTH_TIMESTAMP_HEADER = 'x-worldmonitor-desktop-timestamp';
export const DESKTOP_AUTH_SIGNATURE_HEADER = 'x-worldmonitor-desktop-signature';
export const DESKTOP_AUTH_WINDOW_MS = 5 * 60 * 1000;
const DESKTOP_AUTH_SECRET_ENV = 'WM_DESKTOP_SHARED_SECRET';
const DESKTOP_AUTH_ALLOW_LEGACY_ENV = 'WM_DESKTOP_AUTH_ALLOW_LEGACY';

// Legacy api/register-interest.js capped desktop-source signups at 2/hr per IP
// on top of the generic 5/hr endpoint budget. The desktop bypass is now
// authenticated with HMAC headers when WM_DESKTOP_SHARED_SECRET is configured;
// the scoped cap remains as a second-stage abuse backstop.
const DESKTOP_RATE_SCOPE = '/api/leads/v1/register-interest#desktop';
const DESKTOP_RATE_LIMIT = 2;
const DESKTOP_RATE_WINDOW = '1 h' as const;

interface ConvexRegisterResult {
  status: 'registered' | 'already_registered';
  referralCode: string;
  referralCount: number;
  position?: number;
  emailSuppressed?: boolean;
}

function canonicalizeDesktopAuthPayload(req: RegisterInterestRequest): string {
  return JSON.stringify({
    email: typeof req.email === 'string' ? req.email : '',
    source: typeof req.source === 'string' ? req.source : '',
    appVersion: typeof req.appVersion === 'string' ? req.appVersion : '',
    referredBy: typeof req.referredBy === 'string' ? req.referredBy : '',
    website: typeof req.website === 'string' ? req.website : '',
    turnstileToken: typeof req.turnstileToken === 'string' ? req.turnstileToken : '',
  });
}

function desktopAuthMessage(timestamp: string, req: RegisterInterestRequest): string {
  return `${timestamp}\n${canonicalizeDesktopAuthPayload(req)}`;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const maxLength = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < maxLength; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export async function createDesktopAuthSignature(
  secret: string,
  timestamp: string,
  req: RegisterInterestRequest,
): Promise<string> {
  return `sha256=${await hmacSha256Hex(secret, desktopAuthMessage(timestamp, req))}`;
}

async function verifyDesktopAuth(request: Request, req: RegisterInterestRequest): Promise<void> {
  const secret = process.env[DESKTOP_AUTH_SECRET_ENV];
  const timestamp = request.headers.get(DESKTOP_AUTH_TIMESTAMP_HEADER);
  const signature = request.headers.get(DESKTOP_AUTH_SIGNATURE_HEADER);

  if (!secret) {
    if (!timestamp && !signature && process.env[DESKTOP_AUTH_ALLOW_LEGACY_ENV] === 'true') {
      console.warn(
        `[register-interest] ${DESKTOP_AUTH_ALLOW_LEGACY_ENV}=true and ${DESKTOP_AUTH_SECRET_ENV} is unset; accepting unsigned legacy desktop bypass`,
      );
      return;
    }

    console.warn(`[register-interest] ${DESKTOP_AUTH_SECRET_ENV} not set; rejecting desktop bypass`);
    throw new ApiError(403, 'Desktop authentication failed', '');
  }

  if (!timestamp || !signature) {
    throw new ApiError(403, 'Desktop authentication failed', '');
  }

  const timestampMs = Number(timestamp);
  if (!Number.isSafeInteger(timestampMs) || Math.abs(Date.now() - timestampMs) > DESKTOP_AUTH_WINDOW_MS) {
    throw new ApiError(403, 'Desktop authentication failed', '');
  }

  const supplied = signature.trim();
  if (!/^sha256=[a-f0-9]{64}$/.test(supplied)) {
    throw new ApiError(403, 'Desktop authentication failed', '');
  }

  const expected = await createDesktopAuthSignature(secret, timestamp, req);
  if (!timingSafeStringEqual(supplied, expected)) {
    throw new ApiError(403, 'Desktop authentication failed', '');
  }
}

async function sendConfirmationEmail(email: string, referralCode: string): Promise<void> {
  const referralLink = `https://worldmonitor.app/pro?ref=${referralCode}`;
  const shareText = encodeURIComponent("I just joined the World Monitor Pro waitlist \u2014 real-time global intelligence powered by AI. Join me:");
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
        subject: "You\u2019re on the World Monitor Pro waitlist",
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; background: #0a0a0a; color: #e0e0e0;">
            <div style="background: #4ade80; height: 4px;"></div>
            <div style="padding: 40px 32px 0;">
              <table cellpadding="0" cellspacing="0" border="0" style="margin: 0 auto 32px;">
                <tr>
                  <td style="width: 40px; height: 40px; vertical-align: middle;">
                    <img src="https://www.worldmonitor.app/favico/android-chrome-192x192.png" width="40" height="40" alt="WorldMonitor" style="border-radius: 50%; display: block;" />
                  </td>
                  <td style="padding-left: 12px;">
                    <div style="font-size: 16px; font-weight: 800; color: #fff; letter-spacing: -0.5px;">WORLD MONITOR</div>
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
                      <div style="font-size: 13px; font-weight: 700; color: #fff; margin-bottom: 4px;">30+ Services, 1 Key</div>
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
                    <div style="font-size: 22px; font-weight: 800; color: #4ade80;">500+</div>
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
                <a href="https://worldmonitor.app/dashboard" style="display: inline-block; background: #4ade80; color: #0a0a0a; padding: 14px 36px; text-decoration: none; font-weight: 800; font-size: 13px; text-transform: uppercase; letter-spacing: 1.5px; border-radius: 2px;">Explore the Free Dashboard</a>
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

export async function registerInterest(
  ctx: ServerContext,
  req: RegisterInterestRequest,
): Promise<RegisterInterestResponse> {
  // Honeypot — silently accept but do nothing.
  if (req.website) {
    return { status: 'registered', referralCode: '', referralCount: 0, position: 0, emailSuppressed: false };
  }

  const ip = getClientIp(ctx.request);
  const isDesktopSource = typeof req.source === 'string' && DESKTOP_SOURCES.has(req.source);

  // Desktop sources bypass Turnstile because the app shell has no browser
  // captcha surface. Authenticate that bypass with a shared-secret HMAC, then
  // keep the tighter per-IP budget as a second-stage abuse cap.
  if (isDesktopSource) {
    await verifyDesktopAuth(ctx.request, req);
    const scoped = await checkScopedRateLimit(
      DESKTOP_RATE_SCOPE,
      DESKTOP_RATE_LIMIT,
      DESKTOP_RATE_WINDOW,
      ip,
    );
    if (scoped.degraded) {
      throw new ApiError(503, 'Rate-limit service temporarily unavailable', '');
    }
    if (!scoped.allowed) {
      throw new ApiError(429, 'Too many requests', '');
    }
  } else {
    const turnstileOk = await verifyTurnstile({
      token: req.turnstileToken || '',
      ip,
      logPrefix: '[register-interest]',
    });
    if (!turnstileOk) {
      throw new ApiError(403, 'Bot verification failed', '');
    }
  }

  const { email, source, appVersion, referredBy } = req;
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
    throw new ValidationError([{ field: 'email', description: 'Invalid email address' }]);
  }

  const emailCheck = await validateEmail(email);
  if (!emailCheck.valid) {
    throw new ValidationError([{ field: 'email', description: emailCheck.reason }]);
  }

  const safeSource = source ? source.slice(0, MAX_META_LENGTH) : 'unknown';
  const safeAppVersion = appVersion ? appVersion.slice(0, MAX_META_LENGTH) : 'unknown';
  const safeReferredBy = referredBy ? referredBy.slice(0, 20) : undefined;

  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    throw new ApiError(503, 'Registration service unavailable', '');
  }

  const client = new ConvexHttpClient(convexUrl);
  const result = (await client.mutation('registerInterest:register' as any, {
    email,
    source: safeSource,
    appVersion: safeAppVersion,
    referredBy: safeReferredBy,
  })) as ConvexRegisterResult;

  if (result.status === 'registered' && result.referralCode) {
    if (!result.emailSuppressed) {
      await sendConfirmationEmail(email, result.referralCode);
    } else {
      console.log(`[register-interest] Skipped email to suppressed address: ${email}`);
    }
  }

  return {
    status: result.status,
    referralCode: result.referralCode,
    referralCount: result.referralCount,
    position: result.position ?? 0,
    emailSuppressed: result.emailSuppressed ?? false,
  };
}
