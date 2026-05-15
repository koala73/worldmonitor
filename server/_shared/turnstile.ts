const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function getClientIp(request: Request): string {
  // cf-connecting-ip is the trusted client IP set by Cloudflare; x-real-ip
  // is the CF edge IP (shared across users) — kept as a secondary because
  // some non-CF deploys set it directly. x-forwarded-for is client-settable
  // and MUST NOT be used as a rate-limit / abuse-defence identifier (#3531).
  // Trim each value so a whitespace-only header doesn't short-circuit past
  // the next fallback. Mirrors getClientIp in server/_shared/rate-limit.ts.
  const cf = (request.headers.get('cf-connecting-ip') ?? '').trim();
  const xr = (request.headers.get('x-real-ip') ?? '').trim();
  return cf || xr || 'unknown';
}

export type TurnstileMissingSecretPolicy = 'allow' | 'allow-in-development' | 'deny';

export interface VerifyTurnstileArgs {
  token: string;
  ip: string;
  logPrefix?: string;
  missingSecretPolicy?: TurnstileMissingSecretPolicy;
}

export async function verifyTurnstile({
  token,
  ip,
  logPrefix = '[turnstile]',
  // Default: dev = allow (missing secret is expected locally), prod = deny.
  // Callers that need the opposite (deliberately allow missing-secret in prod)
  // can still pass 'allow' explicitly.
  missingSecretPolicy = 'allow-in-development',
}: VerifyTurnstileArgs): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    if (missingSecretPolicy === 'allow') return true;

    const isDevelopment = (process.env.VERCEL_ENV ?? 'development') === 'development';
    if (isDevelopment) return true;

    console.error(`${logPrefix} TURNSTILE_SECRET_KEY not set in production, rejecting`);
    return false;
  }

  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, remoteip: ip }),
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}
