/**
 * Browser access to the brief language (`convex/users.ts`, epic #10877).
 *
 * Every call is bound to the Clerk user that started it, so an account switch
 * mid-flight can never read or write the wrong row. Failures resolve to
 * `null` / `{ ok: false }`; nothing here throws.
 */
import { getCurrentClerkUser } from './clerk';
import { getConvexApi, getConvexClient, waitForConvexAuthForUser } from './convex-client';

export interface BriefLanguageState {
  uiLanguage: string | null;
  briefLanguage: string | null;
  effective: string;
  /** Languages the brief is delivered in now; absent from an older Convex deploy. */
  deliverableLanguages?: string[];
}

export type BriefLanguageWriteResult = { ok: true } | { ok: false; reason: string };

const AUTH_WAIT_MS = 8_000;

async function boundClient(userId: string) {
  const [client, api] = await Promise.all([getConvexClient(), getConvexApi()]);
  if (!client || !api) return null;
  if (!(await waitForConvexAuthForUser(userId, AUTH_WAIT_MS))) return null;
  return { client, api };
}

export async function loadBriefLanguage(userId: string): Promise<BriefLanguageState | null> {
  try {
    const bound = await boundClient(userId);
    if (!bound || getCurrentClerkUser()?.id !== userId) return null;
    return (await bound.client.query(bound.api.users.getBriefLanguage, {})) ?? null;
  } catch (error) {
    console.warn('[brief-language] read failed', error);
    return null;
  }
}

export async function saveBriefLanguage(userId: string, lang: string | null): Promise<BriefLanguageWriteResult> {
  try {
    const bound = await boundClient(userId);
    if (!bound || getCurrentClerkUser()?.id !== userId) return { ok: false, reason: 'unauthenticated' };
    return await bound.client.mutation(bound.api.users.setBriefLanguage, { lang });
  } catch (error) {
    console.warn('[brief-language] write failed', error);
    return { ok: false, reason: 'error' };
  }
}
