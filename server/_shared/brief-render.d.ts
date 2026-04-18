import type { BriefEnvelope } from '../../shared/brief-envelope.js';

/**
 * Render options.
 *
 * - `publicMode`: when true, personal fields (user.name, per-story
 *   `whyMatters`) are replaced with generic placeholders, the back
 *   cover swaps to a Subscribe CTA, a top Subscribe strip is added,
 *   and the Share button + script are suppressed. Used by the
 *   unauth'd /api/brief/public/{hash} route.
 *
 * - `refCode`: optional referral code; interpolated into the public
 *   Subscribe CTAs as `?ref=<code>` for signup attribution. Shape-
 *   validated at the route boundary; still HTML-escaped here.
 *
 * - `shareUrl`: absolute URL that the Share button will invoke via
 *   `navigator.share` / clipboard fallback. Derived server-side by
 *   the per-user magazine route so the click handler makes no
 *   network calls and does not require Clerk session context. When
 *   omitted (or empty) the Share button is suppressed entirely
 *   (graceful degrade if BRIEF_SHARE_SECRET is unconfigured). Always
 *   ignored under publicMode.
 */
export interface RenderBriefMagazineOptions {
  publicMode?: boolean;
  refCode?: string;
  shareUrl?: string;
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
