/**
 * POST /api/user/passkey-offer
 *
 * Reserves one of three lifetime passkey-offer slots for the authenticated
 * Clerk account. Redis HSETNX owns the monotonic write. Clerk unsafe metadata
 * is a browser-readable migration source and terminal mirror only.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error JS module without declarations.
import { getCorsHeaders } from '../_cors.js';
// @ts-expect-error JS module without declarations.
import { captureSilentError } from '../_sentry-edge.js';
import { resolveClerkSession } from '../../server/_shared/auth-session';
import {
  reservePasskeyOfferSlot,
  type PasskeyOfferReservation,
  type PasskeyOfferSlotStore,
} from '../../server/_shared/passkey-offer-reservation';
import {
  ACCOUNT_OFFER_CAP,
  ACCOUNT_OFFER_COUNT_KEY,
  readAccountOfferCount,
} from '../../shared/passkey-offer-contract';
import { runRedisPipeline } from '../../server/_shared/redis';

const CLERK_API_TIMEOUT_MS = 3_000;
const REDIS_CLAIM_TIMEOUT_MS = 2_000;
const SLOT_KEY_PREFIX = 'passkey-offer-slots';

export interface PasskeyOfferDeps {
  resolveUserId(request: Request): Promise<string | null>;
  readMigratedCount(userId: string): Promise<number>;
  reserve(userId: string, migratedCount: number): Promise<PasskeyOfferReservation>;
  persistTerminalCount(userId: string): Promise<void>;
}

function clerkHeaders(): Record<string, string> {
  const secret = process.env.CLERK_SECRET_KEY;
  if (!secret) throw new Error('CLERK_SECRET_KEY is not configured');
  return {
    Authorization: `Bearer ${secret}`,
    'Content-Type': 'application/json',
    'User-Agent': 'worldmonitor-gateway/1.0',
  };
}

export async function readClerkMigratedCount(userId: string): Promise<number> {
  const response = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
    headers: clerkHeaders(),
    signal: AbortSignal.timeout(CLERK_API_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Clerk user read failed with ${response.status}`);
  const user = (await response.json()) as { unsafe_metadata?: Record<string, unknown> | null };
  return readAccountOfferCount({ unsafeMetadata: user.unsafe_metadata });
}

export async function persistClerkTerminalCount(userId: string): Promise<void> {
  const response = await fetch(
    `https://api.clerk.com/v1/users/${encodeURIComponent(userId)}/metadata`,
    {
      method: 'PATCH',
      headers: clerkHeaders(),
      body: JSON.stringify({
        unsafe_metadata: { [ACCOUNT_OFFER_COUNT_KEY]: ACCOUNT_OFFER_CAP },
      }),
      signal: AbortSignal.timeout(CLERK_API_TIMEOUT_MS),
    },
  );
  if (!response.ok) throw new Error(`Clerk metadata update failed with ${response.status}`);
}

export function createRedisSlotStore(userId: string): PasskeyOfferSlotStore {
  const key = `${SLOT_KEY_PREFIX}:${userId}`;
  return {
    async claim(slot) {
      const [result] = await runRedisPipeline(
        [['HSETNX', key, String(slot), '1']],
        false,
        REDIS_CLAIM_TIMEOUT_MS,
      );
      if (!result || result.error) {
        throw new Error(result?.error ?? 'Redis slot reservation returned no result');
      }
      if (result.result === 1 || result.result === '1') return true;
      if (result.result === 0 || result.result === '0') return false;
      throw new Error('Redis slot reservation returned an invalid result');
    },
  };
}

export async function passkeyOfferHandler(
  request: Request,
  deps: PasskeyOfferDeps,
): Promise<Response> {
  const cors = getCorsHeaders(request);
  const jsonHeaders = {
    ...cors,
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { ...jsonHeaders, Allow: 'POST, OPTIONS' },
    });
  }

  const userId = await deps.resolveUserId(request);
  if (!userId) {
    return new Response(JSON.stringify({ error: 'unauthenticated' }), {
      status: 401,
      headers: jsonHeaders,
    });
  }

  let migratedCount: number;
  let reservation: PasskeyOfferReservation;
  try {
    migratedCount = await deps.readMigratedCount(userId);
    reservation = await deps.reserve(userId, migratedCount);
  } catch (error) {
    console.warn(
      '[passkey-offer] reservation failed:',
      error instanceof Error ? error.message : String(error),
    );
    captureSilentError(error, { tags: { route: 'api/user/passkey-offer', step: 'reserve' } });
    return new Response(JSON.stringify({ error: 'service_unavailable' }), {
      status: 503,
      headers: { ...jsonHeaders, 'Retry-After': '5' },
    });
  }

  if (reservation.count === ACCOUNT_OFFER_CAP && migratedCount < ACCOUNT_OFFER_CAP) {
    try {
      await deps.persistTerminalCount(userId);
    } catch (error) {
      console.warn(
        '[passkey-offer] Clerk terminal mirror failed:',
        error instanceof Error ? error.message : String(error),
      );
      captureSilentError(error, { tags: { route: 'api/user/passkey-offer', step: 'clerk-mirror' } });
    }
  }

  return new Response(JSON.stringify(reservation), { status: 200, headers: jsonHeaders });
}

export default async function handler(request: Request): Promise<Response> {
  return passkeyOfferHandler(request, {
    resolveUserId: async (req) => (await resolveClerkSession(req))?.userId ?? null,
    readMigratedCount: readClerkMigratedCount,
    reserve: (userId, migratedCount) => (
      reservePasskeyOfferSlot(createRedisSlotStore(userId), migratedCount)
    ),
    persistTerminalCount: persistClerkTerminalCount,
  });
}
