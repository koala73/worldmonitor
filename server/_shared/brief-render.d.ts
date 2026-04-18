import type { BriefEnvelope } from '../../shared/brief-envelope.js';

/**
 * Render options.
 *
 * - `publicMode`: when true, personal fields (user.name, per-story
 *   `whyMatters`) are replaced with generic placeholders, the back
 *   cover swaps to a Subscribe CTA, a top Subscribe strip is added,
 *   and the authenticated-only Share button + script are suppressed.
 *   Used by the unauth'd /api/brief/public/{hash} route.
 *
 * - `refCode`: optional referral code; interpolated into the public
 *   Subscribe CTAs as `?ref=<code>` for signup attribution. Shape-
 *   validated at the route boundary; still HTML-escaped here.
 */
export interface RenderBriefMagazineOptions {
  publicMode?: boolean;
  refCode?: string;
}

export function renderBriefMagazine(
  envelope: BriefEnvelope,
  options?: RenderBriefMagazineOptions,
): string;

/**
 * Validates the entire envelope (closed-key contract, field shapes,
 * version, and the `surfaced === stories.length` cross-field rule).
 * Shared between the renderer (call site: `renderBriefMagazine`) and
 * preview readers that must honour the same contract so a "ready"
 * preview never points at an envelope the renderer will reject.
 */
export function assertBriefEnvelope(envelope: unknown): asserts envelope is BriefEnvelope;
