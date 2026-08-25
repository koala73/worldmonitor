export const IDEMPOTENCY_HEADER: 'Idempotency-Key';
export const IDEMPOTENT_REPLAYED_HEADER: 'Idempotent-Replayed';

export type StandaloneIdempotencyTerminal =
  // Fail-OPEN: idempotency could not be applied (Redis unreachable or
  // misconfigured, body unreadable). Callers deliberately proceed unprotected.
  | { kind: 'disabled' }
  // Fail-CLOSED: `scope` was missing, empty, or not a string — a server-side
  // wiring bug, never a runtime condition. The request is refused with a 500
  // rather than silently losing duplicate-write protection.
  | { kind: 'misconfigured'; response: Response }
  | { kind: 'invalid'; response: Response }
  | { kind: 'replay'; response: Response }
  | { kind: 'conflict'; response: Response }
  | { kind: 'mismatch'; response: Response };

export type StandaloneIdempotencyOutcome =
  | StandaloneIdempotencyTerminal
  | {
      kind: 'proceed';
      key: string;
      store: (status: number, body: ArrayBuffer, contentType: string | null) => Promise<void>;
    };

export type StandaloneIdempotencyPeekOutcome =
  | StandaloneIdempotencyTerminal
  | { kind: 'miss' };

export function isValidIdempotencyKey(key: string): boolean;

export function getIdempotencyKey(request: Request): string | null;

export function peekStandaloneIdempotency(args: {
  request: Request;
  pathname: string;
  scope: string;
  idempotencyKey: string;
  corsHeaders: Record<string, string>;
}): Promise<StandaloneIdempotencyPeekOutcome>;

export function beginStandaloneIdempotency(args: {
  request: Request;
  pathname: string;
  scope: string;
  idempotencyKey: string;
  corsHeaders: Record<string, string>;
  completedTtlSeconds?: number;
}): Promise<StandaloneIdempotencyOutcome>;

export function completeStandaloneIdempotency(
  idempotency: StandaloneIdempotencyOutcome | null,
  response: Response,
): Promise<Response>;
