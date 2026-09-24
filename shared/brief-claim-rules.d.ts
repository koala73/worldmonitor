export function evidenceNumbersGrounded(
  claim: string,
  cited: ReadonlyArray<{ value: string; factText: string }>,
): boolean;

export function isEvidenceLimitClaim(claim: unknown): boolean;
