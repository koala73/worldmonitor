/**
 * The About-you questionnaire: question ids, option ids, and limits, shared by
 * the dashboard card, the Pro activation step, the MCP connect screen, Convex
 * validation (`convex/audienceProfile.ts`), and the weekly audience export.
 *
 * Pure data, no imports and no DOM types, so `src/` and `convex/` can both take
 * it. Labels are NOT here: every surface renders them from locale keys
 * (`aboutYou.questions.<questionId>.options.<optionId>`), so the ids below are
 * the contract and wording can change without migrating stored answers.
 *
 * Changing what a question means (not only its wording) bumps
 * ABOUT_YOU_VERSION, so answers given under the old meaning stay separable.
 */

export const ABOUT_YOU_VERSION = 1;

export const ABOUT_YOU_CHOICE_QUESTIONS = {
  primaryUse: [
    'news',
    'markets',
    'commodities',
    'travel',
    'security',
    'research',
    'api-agent',
    'other',
  ],
  usageContext: ['personal', 'work'],
  payer: ['self', 'employer', 'not-paying'],
  role: [
    'analyst',
    'trader',
    'journalist',
    'security',
    'government',
    'supply-chain',
    'developer',
    'student',
    'other',
  ],
} as const;

export type AboutYouChoiceQuestionId = keyof typeof ABOUT_YOU_CHOICE_QUESTIONS;
export type AboutYouOptionId<Q extends AboutYouChoiceQuestionId> =
  (typeof ABOUT_YOU_CHOICE_QUESTIONS)[Q][number];

/** Display order. The two key questions come first (R3). */
export const ABOUT_YOU_QUESTION_ORDER = [
  'primaryUse',
  'usageContext',
  'payer',
  'role',
  'alternative',
] as const;
export type AboutYouQuestionId = (typeof ABOUT_YOU_QUESTION_ORDER)[number];

/**
 * The answers the report segments on. When either is still empty after the
 * card closes, the card returns once for the empty ones (R19).
 */
export const ABOUT_YOU_KEY_QUESTIONS = ['primaryUse', 'usageContext'] as const;

/** The free-text "what would you use if WorldMonitor didn't exist?" answer. */
export const ABOUT_YOU_FREE_TEXT_MAX = 280;

/** Where an answer or skip was given. */
export const ABOUT_YOU_SURFACES = [
  'dashboard',
  'activation',
  'mcp-connect',
  'churn-ask',
  'churn-email',
] as const;
export type AboutYouSurface = (typeof ABOUT_YOU_SURFACES)[number];

/**
 * The return visit (R19) waits this long after the last answer, so a reload
 * right after closing the card does not count as "a later visit".
 */
export const ABOUT_YOU_RETURN_DELAY_MS = 24 * 60 * 60 * 1000;

/**
 * Dodo's `cancellation_feedback` enum. Our gap-fill churn ask offers the same
 * list, so answers from Dodo and from us count in one column.
 */
export const CHURN_REASON_IDS = [
  'too_expensive',
  'missing_features',
  'switched_service',
  'unused',
  'customer_service',
  'low_quality',
  'too_complex',
  'other',
] as const;
export type ChurnReasonId = (typeof CHURN_REASON_IDS)[number];

export function isAboutYouChoiceQuestion(id: string): id is AboutYouChoiceQuestionId {
  return Object.prototype.hasOwnProperty.call(ABOUT_YOU_CHOICE_QUESTIONS, id);
}

export function isAboutYouOption(questionId: AboutYouChoiceQuestionId, optionId: string): boolean {
  return (ABOUT_YOU_CHOICE_QUESTIONS[questionId] as readonly string[]).includes(optionId);
}

export function isAboutYouSurface(value: string): value is AboutYouSurface {
  return (ABOUT_YOU_SURFACES as readonly string[]).includes(value);
}

export function isChurnReasonId(value: string): value is ChurnReasonId {
  return (CHURN_REASON_IDS as readonly string[]).includes(value);
}

/** Trim and cap free text; returns null when nothing is left to store. */
export function normalizeAboutYouFreeText(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return Array.from(trimmed).slice(0, ABOUT_YOU_FREE_TEXT_MAX).join('');
}
