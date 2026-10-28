// Two-dot name on purpose: see companyMonitoring.helpers.ts — a one-dot file
// under convex/ becomes a backend module and fails the push.
//
// Key issuance (`apiKeys.createApiKey`) is an action that asks Clerk whether
// the caller's session (`sid`) is still live before writing the row. These
// helpers give a test an identity that carries a session and a Clerk that
// answers for it, so the existing issuance tests keep exercising the row
// logic rather than the liveness gate.
import { afterEach, beforeEach, vi } from "vitest";

export const TEST_CLERK_SECRET_KEY = "sk_test_convex_sessions";

/** The session id a test identity carries; the stub derives the owner from it. */
export function sessionIdFor(subject: string): string {
  return `sess_${subject}`;
}

/** The identity with a Clerk `sid`, as a real session token presents it. */
export function liveSession<T extends { subject: string }>(identity: T): T & { sid: string } {
  return { ...identity, sid: sessionIdFor(identity.subject) };
}

export type ClerkSessionAnswer =
  | { status: string; userId?: string }
  | { httpStatus: number }
  | { throws: Error };

export interface ClerkSessionStubOptions {
  /** Per-session overrides; anything else answers `active` for the sid's owner. */
  sessions?: Record<string, ClerkSessionAnswer>;
  /** Every non-Clerk URL goes here; defaults to refusing the call. */
  next?: typeof fetch;
}

/** A fetch that answers Clerk's GET /v1/sessions/{sid} and delegates the rest. */
export function clerkSessionFetch(options: ClerkSessionStubOptions = {}): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const match = url.match(/^https:\/\/api\.clerk\.com\/v1\/sessions\/([^/?]+)$/);
    if (!match) {
      if (options.next) return options.next(input, init);
      throw new Error(`unexpected fetch ${url}`);
    }
    calls.push(url);
    const sid = decodeURIComponent(match[1]!);
    const answer = options.sessions?.[sid] ?? { status: "active" };
    if ("throws" in answer) throw answer.throws;
    if ("httpStatus" in answer) return new Response("", { status: answer.httpStatus });
    const userId = answer.userId ?? sid.replace(/^sess_/, "");
    return Response.json({ id: sid, status: answer.status, user_id: userId });
  }) as typeof fetch & { calls: string[] };
  stub.calls = calls;
  return stub;
}

/** Install a live-session Clerk for every test in the file. */
export function installLiveClerkSessions(): void {
  let originalSecret: string | undefined;
  beforeEach(() => {
    originalSecret = process.env.CLERK_SECRET_KEY;
    process.env.CLERK_SECRET_KEY = TEST_CLERK_SECRET_KEY;
    vi.stubGlobal("fetch", clerkSessionFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalSecret === undefined) delete process.env.CLERK_SECRET_KEY;
    else process.env.CLERK_SECRET_KEY = originalSecret;
  });
}
