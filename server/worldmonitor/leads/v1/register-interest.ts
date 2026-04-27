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

// Legacy api/register-interest.js capped desktop-source signups at 2/hr per IP
// on top of the generic 5/hr endpoint budget. Since `source` is an unsigned
// client-supplied field, this cap is the backstop — the signed-header fix that
// actually authenticates the desktop bypass is tracked as a follow-up.
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

  // Desktop sources bypass Turnstile (no browser captcha). `source` is
  // attacker-controlled, so anyone claiming desktop-settings skips the
  // captcha — apply a tighter 2/hr per-IP cap on that path to cap abuse
  // (matches the legacy handler's in-memory secondary cap). Proper fix is
  // a signed desktop-secret header; tracked as a follow-up.
  if (isDesktopSource) {
    const scoped = await checkScopedRateLimit(
      DESKTOP_RATE_SCOPE,
      DESKTOP_RATE_LIMIT,
      DESKTOP_RATE_WINDOW,
      ip,
    );
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
