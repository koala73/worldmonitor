import type { BriefEnvelope } from '../../shared/brief-envelope.js';

export function renderBriefMagazine(envelope: BriefEnvelope): string;

/**
 * Validates the entire envelope (closed-key contract, field shapes,
 * version, and the `surfaced === stories.length` cross-field rule).
 * Shared between the renderer (call site: `renderBriefMagazine`) and
 * preview readers that must honour the same contract so a "ready"
 * preview never points at an envelope the renderer will reject.
 */
export function assertBriefEnvelope(envelope: unknown): asserts envelope is BriefEnvelope;
