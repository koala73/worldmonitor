/**
 * Browser access to the About-you profile (`convex/audienceProfile.ts`).
 *
 * Every call is bound to the Clerk user that started it: it waits for the
 * shared Convex client to carry that user's token and gives up otherwise, so
 * an account switch mid-flight can never read or write the wrong profile.
 * Failures resolve to `null` / `{ ok: false }`; nothing here throws.
 */
import type { AboutYouChoiceQuestionId, AboutYouSurface } from '../../shared/audience-profile';
import { getConvexApi, getConvexClient, waitForConvexAuthForUser } from './convex-client';
import type { AboutYouStatus } from './onboarding-prompt';

export type ProfileWriteResult = { ok: true } | { ok: false; reason: string };

const AUTH_WAIT_MS = 8_000;

async function boundClient(userId: string) {
  const [client, api] = await Promise.all([getConvexClient(), getConvexApi()]);
  if (!client || !api) return null;
  if (!(await waitForConvexAuthForUser(userId, AUTH_WAIT_MS))) return null;
  return { client, api };
}

export async function loadAboutYouStatus(userId: string): Promise<AboutYouStatus | null> {
  try {
    const bound = await boundClient(userId);
    if (!bound) return null;
    return (await bound.client.query(bound.api.audienceProfile.getStatus, {})) ?? null;
  } catch (error) {
    console.warn('[about-you] status read failed', error);
    return null;
  }
}

async function write(
  userId: string,
  run: (bound: NonNullable<Awaited<ReturnType<typeof boundClient>>>) => Promise<ProfileWriteResult>,
): Promise<ProfileWriteResult> {
  try {
    const bound = await boundClient(userId);
    if (!bound) return { ok: false, reason: 'unauthenticated' };
    return await run(bound);
  } catch (error) {
    console.warn('[about-you] write failed', error);
    return { ok: false, reason: 'error' };
  }
}

export function recordAboutYouAnswer(
  userId: string,
  questionId: AboutYouChoiceQuestionId,
  optionId: string,
  surface: AboutYouSurface,
): Promise<ProfileWriteResult> {
  return write(userId, ({ client, api }) =>
    client.mutation(api.audienceProfile.recordAnswer, { questionId, optionId, surface }),
  );
}

export function recordAboutYouAnswers(
  userId: string,
  surface: AboutYouSurface,
  answers: Partial<Record<AboutYouChoiceQuestionId | 'alternative', string>>,
): Promise<ProfileWriteResult> {
  return write(userId, ({ client, api }) =>
    client.mutation(api.audienceProfile.recordAnswers, { surface, ...answers }),
  );
}

export function recordAboutYouFreeText(
  userId: string,
  text: string,
  surface: AboutYouSurface,
): Promise<ProfileWriteResult> {
  return write(userId, async ({ client, api }) => {
    const result = await client.mutation(api.audienceProfile.recordFreeText, { text, surface });
    return result.ok ? { ok: true } : result;
  });
}

export function skipAboutYou(userId: string, surface: AboutYouSurface): Promise<ProfileWriteResult> {
  return write(userId, ({ client, api }) => client.mutation(api.audienceProfile.skip, { surface }));
}

export function markAboutYouReturnShown(userId: string): Promise<ProfileWriteResult> {
  return write(userId, ({ client, api }) => client.mutation(api.audienceProfile.markReturnShown, {}));
}
