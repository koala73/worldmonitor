const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function getClientIp(request) {
  // Prefer platform-populated IP headers before falling back to x-forwarded-for.
  return (
    request.headers.get('x-real-ip') ||
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

export async function verifyTurnstile({
  token,
  ip,
  logPrefix = '[turnstile]',
  missingSecretPolicy = 'allow',
}) {
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
    const data = await res.json();
    return data.success === true;
  } catch {
    return false;
  }
}
