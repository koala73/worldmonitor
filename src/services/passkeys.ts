/**
 * Passkey capability and creation, in front of Clerk.
 *
 * Clerk's prebuilt components already handle signing in with a passkey, browser
 * autofill, and passkey management in the account menu — all driven by the
 * dashboard toggles, with no code here. This module exists only for the one
 * thing Clerk has no surface for: creating a passkey on demand, from our own
 * post-sign-in offer.
 *
 * Everything that decides is a pure function over injected facts. That is not
 * style: the environment gate is what implements the desktop exclusion, and a
 * gate that reads globals cannot be tested against a fabricated desktop. The
 * live readers at the bottom of this file are the only part that touches Clerk
 * or `window`.
 */

import { getClerk } from './clerk';

// ---------------------------------------------------------------------------
// Environment gate (pure)
// ---------------------------------------------------------------------------

/** Everything the environment gate is allowed to know. Injected, never read here. */
export interface PasskeyEnvironmentFacts {
  /**
   * The canonical desktop signal, `AppContext.isDesktopApp`. Three signals in
   * this repo disagree — `desktop-runtime.ts` checks the UA plus a secure
   * localhost origin, `push-notifications.ts` checks Tauri globals only — so
   * the caller passes the canonical one rather than this leaf picking.
   */
  isDesktopApp: boolean;
  inIframe: boolean;
  hasPublicKeyCredential: boolean;
}

/**
 * Whether a passkey can be created in this environment at all.
 *
 * Desktop is excluded because the Tauri shell runs from `tauri://localhost`,
 * not `worldmonitor.app`, so the relying-party id cannot match and Clerk raises
 * `passkey_invalid_rpID_or_domain`. Cross-origin iframes need an explicit
 * `publickey-credentials-create` grant from the host page, which the embed does
 * not give.
 */
export function isPasskeyEnvironmentEligible(facts: PasskeyEnvironmentFacts): boolean {
  if (facts.isDesktopApp) return false;
  if (facts.inIframe) return false;
  if (!facts.hasPublicKeyCredential) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Session readiness (pure)
// ---------------------------------------------------------------------------

/** The session facts that decide whether the offer may fire. */
export interface PasskeySessionFacts {
  isSignedIn: boolean;
  sessionStatus: string | null;
  hasCurrentTask: boolean;
}

/**
 * Whether the session is actually usable, which is NOT the same question as
 * "is there a user".
 *
 * `getCurrentClerkUser()` returns `clerkInstance.user` without consulting
 * `session.status`, `session.currentTask`, or `clerk.isSignedIn`. Clerk can
 * hydrate a user while the session still carries a pending task (MFA
 * enrolment, organization selection) and treats such a session as not fully
 * signed in. Gating the offer on `user !== null` alone would pop it in the
 * middle of an unfinished auth flow.
 *
 * Deliberately local: widening the global user projection would change
 * behaviour for every auth and entitlement consumer in the app.
 */
export function isPasskeySessionReady(facts: PasskeySessionFacts): boolean {
  return facts.isSignedIn && facts.sessionStatus === 'active' && !facts.hasCurrentTask;
}

// ---------------------------------------------------------------------------
// Passkey count (pure)
// ---------------------------------------------------------------------------

type PasskeyBearingUser = { passkeys?: unknown } | null | undefined;

/**
 * How many passkeys the account already has.
 *
 * Safe to read straight off the local user resource: the SDK hydrates
 * `passkeys` eagerly, in the same pass and from the same session payload as
 * `emailAddresses` and `externalAccounts`. It is not a lazily fetched
 * sub-resource, so no `reload()` is needed on the sign-in path.
 */
export function countPasskeys(user: PasskeyBearingUser): number {
  const passkeys = user?.passkeys;
  return Array.isArray(passkeys) ? passkeys.length : 0;
}

// ---------------------------------------------------------------------------
// Error classification (pure)
// ---------------------------------------------------------------------------

/**
 * What happened, at the granularity the UI branches on.
 *
 * `retryable` is not "a small failure" — it means the attempt is still live and
 * the user can try again from the open card. `failed` ends the attempt.
 */
export type PasskeyOutcome = 'created' | 'retryable' | 'failed';

/**
 * Codes that mean the goal is already met. An existing credential is a success
 * from the user's point of view, not an error to report.
 */
const CREATED_CODES = new Set(['passkey_already_exists']);

/**
 * Codes that genuinely cannot succeed on this device, so retrying is pointless
 * and showing a persistent error is honest.
 *
 * `passkey_invalid_rpID_or_domain` should be unreachable given the iframe and
 * desktop gates above; it is listed so a gate regression surfaces as a real
 * error rather than an infinite retry loop.
 */
const FAILED_CODES = new Set([
  'passkey_not_supported',
  'passkey_pa_not_supported',
  'passkey_invalid_rpID_or_domain',
]);

/**
 * Map a Clerk error code to an outcome.
 *
 * The default is deliberately `retryable`, including for codes we have never
 * seen. The asymmetry is the point: a wrong `retryable` costs one extra button
 * press, while a wrong `failed` ends the attempt and shows the user an error
 * they can do nothing about. Two classes that look like failures but are not:
 * a misconfigured dashboard (every attempt fails server-side, but the device is
 * fine) and transient network/5xx.
 */
export function classifyPasskeyErrorCode(code: string | null | undefined): PasskeyOutcome {
  if (!code) return 'retryable';
  if (CREATED_CODES.has(code)) return 'created';
  if (FAILED_CODES.has(code)) return 'failed';
  return 'retryable';
}

/**
 * Pull the error code out of whichever shape Clerk used.
 *
 * Clerk surfaces codes both as a direct `code` property and inside a structured
 * `errors[]` array; reading one shape misclassifies half the vocabulary. Never
 * branch on `err.constructor.name` — minified bundles mangle it, and the
 * mangled name changes on every rebuild.
 */
export function readPasskeyErrorCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const direct = (err as { code?: unknown }).code;
  if (typeof direct === 'string' && direct) return direct;
  const errors = (err as { errors?: unknown }).errors;
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      const code = (entry as { code?: unknown } | null)?.code;
      if (typeof code === 'string' && code) return code;
    }
  }
  return null;
}

/** Classify a thrown Clerk error, from either code shape. */
export function classifyPasskeyFailure(err: unknown): PasskeyOutcome {
  return classifyPasskeyErrorCode(readPasskeyErrorCode(err));
}

// ---------------------------------------------------------------------------
// Platform authenticator probe
// ---------------------------------------------------------------------------

type PlatformAuthenticatorProbe = (() => Promise<boolean>) | null | undefined;

/**
 * Whether this device has a platform authenticator (Touch ID, Windows Hello, a
 * phone's biometric sensor).
 *
 * Resolves `false` rather than throwing on any failure. The probe can reject
 * outright in locked-down or embedded browsers, and an unavailable authenticator
 * is the same outcome as a rejected probe: do not offer.
 */
export async function resolvePlatformAuthenticator(probe: PlatformAuthenticatorProbe): Promise<boolean> {
  if (typeof probe !== 'function') return false;
  try {
    return await probe();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Live readers — the only code here that touches Clerk or `window`
// ---------------------------------------------------------------------------

/** Read the current environment facts for the gate. Never called by the gate itself. */
export function readPasskeyEnvironmentFacts(isDesktopApp: boolean): PasskeyEnvironmentFacts {
  let inIframe = false;
  try {
    inIframe = window.self !== window.top;
  } catch {
    // A cross-origin parent throws on access, which is itself proof of an iframe.
    inIframe = true;
  }
  return {
    isDesktopApp,
    inIframe,
    hasPublicKeyCredential: typeof window !== 'undefined' && 'PublicKeyCredential' in window,
  };
}

/** Read the current session facts. Returns a not-ready snapshot when Clerk is absent. */
export function readPasskeySessionFacts(): PasskeySessionFacts {
  const clerk = getClerk() as unknown as {
    isSignedIn?: boolean;
    session?: { status?: string; currentTask?: unknown } | null;
  } | null;
  const session = clerk?.session ?? null;
  return {
    isSignedIn: clerk?.isSignedIn === true,
    sessionStatus: typeof session?.status === 'string' ? session.status : null,
    hasCurrentTask: Boolean(session?.currentTask),
  };
}

/** Whether the live session is usable for a passkey ceremony. */
export function isLivePasskeySessionReady(): boolean {
  return isPasskeySessionReady(readPasskeySessionFacts());
}

/** How many passkeys the currently signed-in Clerk account has. */
export function getLivePasskeyCount(): number {
  return countPasskeys(getClerk()?.user as PasskeyBearingUser);
}

/** Probe this device for a platform authenticator. */
export function hasPlatformAuthenticator(): Promise<boolean> {
  const pkc = typeof window !== 'undefined'
    ? (window as unknown as {
        PublicKeyCredential?: { isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean> };
      }).PublicKeyCredential
    : undefined;
  const probe = pkc?.isUserVerifyingPlatformAuthenticatorAvailable;
  return resolvePlatformAuthenticator(probe ? () => probe.call(pkc) : null);
}

/**
 * Create a passkey on the current Clerk account.
 *
 * Never throws — the caller branches on the outcome. A missing user is
 * `retryable` rather than `failed`: it means we raced the session, not that the
 * device cannot do this.
 */
export async function createPasskey(): Promise<PasskeyOutcome> {
  const user = getClerk()?.user as { createPasskey?: () => Promise<unknown> } | null | undefined;
  if (!user?.createPasskey) return 'retryable';
  try {
    await user.createPasskey();
    return 'created';
  } catch (err) {
    return classifyPasskeyFailure(err);
  }
}
