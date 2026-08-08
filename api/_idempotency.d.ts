export const IDEMPOTENCY_HEADER: 'Idempotency-Key';
export const IDEMPOTENT_REPLAYED_HEADER: 'Idempotent-Replayed';

export type StandaloneIdempotencyTerminal =
  | { kind: 'disabled' }
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
  scope: string | null;
  idempotencyKey: string;
  corsHeaders: Record<string, string>;
}): Promise<StandaloneIdempotencyPeekOutcome>;

export function beginStandaloneIdempotency(args: {
  request: Request;
  pathname: string;
  scope: string | null;
  idempotencyKey: string;
  corsHeaders: Record<string, string>;
  completedTtlSeconds?: number;
}): Promise<StandaloneIdempotencyOutcome>;

export function completeStandaloneIdempotency(
  idempotency: StandaloneIdempotencyOutcome | null,
  response: Response,
): Promise<Response>;
