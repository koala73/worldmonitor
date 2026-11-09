import { WEB_APP_ORIGIN } from '@/config/web-origin';
import {
  CHECKOUT_HANDOFF_PARAM,
  desktopAccountDigest,
  stampDesktopCheckoutHandoff,
  type DesktopCheckoutHandoff,
} from '../../shared/desktop-checkout-handoff';

const PRO_HOSTS = new Set([new URL(WEB_APP_ORIGIN).hostname, `www.${new URL(WEB_APP_ORIGIN).hostname}`]);
const CLERK_READY_TIMEOUT_MS = 3_000;

async function currentDesktopAccount(): Promise<DesktopCheckoutHandoff> {
  try {
    const { initClerk, getCurrentClerkUser } = await import('./clerk');
    // An upgrade click can land before Clerk restores the saved session, and
    // reading it then would hand off a signed-in app as signed out.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      initClerk().catch(() => {}),
      new Promise((resolve) => { timer = setTimeout(resolve, CLERK_READY_TIMEOUT_MS); }),
    ]);
    clearTimeout(timer);
    const user = getCurrentClerkUser();
    return user ? { account: await desktopAccountDigest(user.id) } : {};
  } catch {
    // No Clerk or no WebCrypto: hand off unnamed, as builds before #10342 did.
    return {};
  }
}

function parseProUrl(rawUrl: string): URL | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const isPro = url.protocol === 'https:'
    && PRO_HOSTS.has(url.hostname)
    && (url.pathname === '/pro' || url.pathname === '/pro/');
  return isPro && !url.searchParams.has(CHECKOUT_HANDOFF_PARAM) ? url : null;
}

/** Whether a desktop exit to this URL still needs the /pro handoff. */
export function needsDesktopCheckoutHandoff(rawUrl: string): boolean {
  return parseProUrl(rawUrl) !== null;
}

/**
 * Marks a desktop exit to /pro as a desktop handoff that names the signed-in
 * account (#5911, #10342). Applied in the desktop opener, so every upgrade
 * CTA, fallback and plain link reaches /pro the same way. Other URLs pass
 * through unchanged.
 */
export async function withDesktopCheckoutHandoff(rawUrl: string): Promise<string> {
  const url = parseProUrl(rawUrl);
  if (!url) return rawUrl;
  stampDesktopCheckoutHandoff(url.searchParams, await currentDesktopAccount());
  return url.toString();
}
