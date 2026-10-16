export function evidenceNumbersGrounded(
  claim: string,
  cited: ReadonlyArray<{ value: string; factText: string }>,
): boolean;

export function isEvidenceLimitClaim(claim: unknown): boolean;

export function sanctionsEvidenceGrounded(
  text: string,
  headlineCount: number,
  evidence: ReadonlyArray<{ kind: string; factText: string }>,
): boolean;
