/**
 * Logic for the www /desktop-sign-in page (#9396 follow-up). The desktop app
 * opens this page with `#port=…&state=…&challenge=…`. The fragment never
 * reaches a server, so the flow's state stays out of request logs, Sentry
 * URLs and Clerk redirects. The signed-in user confirms, the server binds a
 * one-time code to the challenge, and the page hands the code to the desktop
 * on a 127.0.0.1 loopback redirect. See
 * docs/plans/2026-10-19-desktop-system-browser-sign-in.md.
 */

export const LAUNCH_STORAGE_KEY = 'wm-desktop-sign-in-launch';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export interface LaunchParams {
  port: number;
  state: string;
  challenge: string;
}

export interface LaunchStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

function validLaunch(port: unknown, state: unknown, challenge: unknown): LaunchParams | null {
  const portNumber = typeof port === 'number' ? port : typeof port === 'string' && /^\d{1,5}$/.test(port) ? Number(port) : NaN;
  if (!Number.isInteger(portNumber) || portNumber < 1024 || portNumber > 65535) return null;
  if (typeof state !== 'string' || !TOKEN_RE.test(state)) return null;
  if (typeof challenge !== 'string' || !TOKEN_RE.test(challenge)) return null;
  return { port: portNumber, state, challenge };
}

export function parseLaunchFragment(hash: string): LaunchParams | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  return validLaunch(params.get('port'), params.get('state'), params.get('challenge'));
}

/**
 * The launch for this tab. A fresh fragment wins and is moved to session
 * storage (the page then clears the hash); otherwise the stored launch is
 * used, which survives a Google sign-in redirect that drops the fragment.
 */
export function resolveLaunch(
  hash: string,
  storage: LaunchStorage,
): { launch: LaunchParams | null; clearHash: boolean } {
  const fromHash = parseLaunchFragment(hash);
  if (fromHash) {
    storage.set(LAUNCH_STORAGE_KEY, JSON.stringify(fromHash));
    return { launch: fromHash, clearHash: true };
  }
  try {
    const stored = JSON.parse(storage.get(LAUNCH_STORAGE_KEY) ?? 'null') as Partial<LaunchParams> | null;
    return { launch: stored ? validLaunch(stored.port, stored.state, stored.challenge) : null, clearHash: false };
  } catch {
    return { launch: null, clearHash: false };
  }
}

/** RFC 8252 §7.3: the literal loopback IP, not `localhost`. */
export function callbackUrl(port: number, code: string, state: string): string {
  const url = new URL(`http://127.0.0.1:${port}/callback`);
  url.searchParams.set('code', code);
  url.searchParams.set('state', state);
  return url.toString();
}

export interface ContinueDeps {
  getToken(): Promise<string | null>;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  navigate(url: string): void;
  storage: LaunchStorage;
}

export type ContinueOutcome =
  | { kind: 'redirected' }
  | { kind: 'signed_out' }
  | { kind: 'failed'; status: number };

/** The user's explicit Continue click. Only the challenge goes to the server. */
export async function runDesktopSignInContinue(
  launch: LaunchParams,
  deps: ContinueDeps,
): Promise<ContinueOutcome> {
  const token = await deps.getToken();
  if (!token) return { kind: 'signed_out' };

  const response = await deps.fetch('/api/desktop-auth/authorize', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code_challenge: launch.challenge }),
  });
  if (!response.ok) return { kind: 'failed', status: response.status };
  const body = await response.json().catch(() => null) as { code?: unknown } | null;
  if (typeof body?.code !== 'string') return { kind: 'failed', status: response.status };

  deps.storage.remove(LAUNCH_STORAGE_KEY);
  deps.navigate(callbackUrl(launch.port, body.code, launch.state));
  return { kind: 'redirected' };
}
