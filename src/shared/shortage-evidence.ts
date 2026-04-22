// Evidence helpers for the fuel-shortage registry.
//
// Unlike pipelines/storage, `severity` here is the CLASSIFIER OUTPUT — not
// a client-side derivation. The promotion decision (watch → confirmed)
// lives in the classifier pipeline (proactive-intelligence.mjs post-launch).
// The registry reader just surfaces what the classifier wrote.
//
// What we DO derive client-side is an evidence-quality hint for the panel:
// how many regulator/operator sources does this row have, and how fresh
// are they? That's useful for sorting and tooltip polish without
// contradicting the classifier's severity label.
//
// Versioned so consumers can pin a reader to a spec version and notice
// drift without breaking.

export const SHORTAGE_EVIDENCE_VERSION = 'shortage-evidence-v1';

export type ShortageSeverity = 'confirmed' | 'watch';
export type EvidenceQuality = 'strong' | 'moderate' | 'thin';

export interface ShortageEvidenceSourceInput {
  authority?: string;
  title?: string;
  url?: string;
  date?: string;
  sourceType?: string;
}

export interface ShortageEvidenceInput {
  evidenceSources?: ReadonlyArray<ShortageEvidenceSourceInput>;
  firstRegulatorConfirmation?: string | null;
  classifierVersion?: string;
  classifierConfidence?: number;
  lastEvidenceUpdate?: string;
}

// Classifier-level confidence < 0.75 is noisy; 0.75–0.89 is typical for
// watch; ≥ 0.9 is typical for confirmed with multi-source evidence.
const CONFIDENCE_MODERATE = 0.7;
const CONFIDENCE_STRONG = 0.85;

const EVIDENCE_FRESHNESS_DAYS = 30;

/**
 * Client-side evidence-quality hint. Used by the panel to sort watch-tier
 * entries (stronger evidence first) and render a dotted indicator next to
 * the severity chip. Does NOT change the severity label — that's the
 * classifier's job.
 *
 * Rules:
 *   - strong: confidence ≥ 0.85 AND ≥ 1 regulator/operator source AND evidence ≤ 30d
 *   - moderate: confidence ≥ 0.7 AND (regulator OR operator source) AND evidence ≤ 30d
 *   - thin: everything else (including press-only, stale, or low-confidence rows)
 */
export function deriveShortageEvidenceQuality(
  ev: ShortageEvidenceInput | null | undefined,
  nowMs: number = Date.now(),
): EvidenceQuality {
  if (!ev) return 'thin';
  const confidence = ev.classifierConfidence ?? 0;
  const sources = ev.evidenceSources ?? [];
  const authoritativeCount = sources.filter(s =>
    s?.sourceType === 'regulator' || s?.sourceType === 'operator'
  ).length;
  const fresh = !isStale(ev.lastEvidenceUpdate, nowMs);

  if (confidence >= CONFIDENCE_STRONG && authoritativeCount >= 1 && fresh) return 'strong';
  if (confidence >= CONFIDENCE_MODERATE && authoritativeCount >= 1 && fresh) return 'moderate';
  return 'thin';
}

function isStale(iso: string | undefined, nowMs: number): boolean {
  if (!iso) return true;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return true;
  const ageDays = (nowMs - t) / (1000 * 60 * 60 * 24);
  return ageDays > EVIDENCE_FRESHNESS_DAYS;
}

/**
 * Count regulator/operator (authoritative) vs press/other evidence sources.
 * Used by the panel drawer to show a "n regulator / m press" line so
 * readers can see the source mix at a glance.
 */
export function countEvidenceSources(
  sources: ReadonlyArray<ShortageEvidenceSourceInput> | null | undefined,
): { authoritative: number; press: number; other: number } {
  if (!sources) return { authoritative: 0, press: 0, other: 0 };
  let authoritative = 0;
  let press = 0;
  let other = 0;
  for (const s of sources) {
    const t = s?.sourceType;
    if (t === 'regulator' || t === 'operator') authoritative++;
    else if (t === 'press') press++;
    else other++;
  }
  return { authoritative, press, other };
}
