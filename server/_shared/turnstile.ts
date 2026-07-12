// Keep this module's public helper surface for its lead-handler consumers, but
// use the dependency-free canonical client-IP implementation. This preserves
// Cloudflare transit-proof validation for the scoped rate-limit identity
// instead of maintaining a divergent local copy (#5235, GHSA-c267).
export { getClientIp } from './client-ip';

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

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
