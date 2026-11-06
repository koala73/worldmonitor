/**
 * Refresh-token recovery and replay state.
 *
 * `oauth:famptr:<token>` is durable replay evidence. Normal writes deliberately
 * remain the legacy JSON string family id so an older deployment can still
 * revoke the family after a rollback. A failed recovery replaces that value
 * with a family-free tombstone, which both old and new handlers decline to
 * treat as evidence against the whole family.
 *
 * `oauth:famattempt:<token>` is temporary recovery state. It is created in
 * the same Redis script that consumes the refresh record. A token miss while
 * this key exists is an in-flight or failed attempt, not proven replay.
 *
 * `oauth:famsucc:<sha256(token)>` is the replay grace record (SM-092). A
 * committed rotation writes it in the same pipeline as the rotated tokens, so
 * its presence means "this token was rotated less than
 * REFRESH_REPLAY_GRACE_SECONDS ago and these are the tokens that replaced it".
 * The handler answers ambiguous failures with 503 + Retry-After, which invites
 * the client to present the same token again; MCP hosts also issue duplicate
 * concurrent refreshes. Inside the window the same client gets the successor
 * pair back instead of being branded a replay. The record is bound to the
 * client that rotated, and it is only honoured while the successor refresh
 * token is itself unused: a presentation from another client, after the window,
 * or after the successor rotated is real reuse and still revokes the family.
 * The key is the token's hash so the record cannot be found from a captured
 * token alone without also knowing the key scheme; the successor pair inside it
 * is as exposed as the `oauth:token:` and `oauth:refresh:` key names already
 * are, which the Redis trust boundary already accepts.
 */

/**
 * Idle window of a refresh token, and so of a connector nobody uses. Every
 * rotation writes the new token with the whole window, so it slides: a client
 * that refreshes at least once in 30 days stays connected, and one idle longer
 * signs in again. MCP clients such as Claude refresh only when the connector is
 * used, so the old 7-day value expired connectors after a quiet week.
 *
 * The family pointer and the family revocation marker share this TTL on
 * purpose: replay evidence must outlive any token that could still be
 * presented, or a late replay would stop revoking the family (GHSA-f6gj).
 * Revocation does not wait for expiry: Pro grants are checked against Convex on
 * every refresh and every MCP request (positive results are never cached), and
 * a dashboard key is re-validated on bearer use behind a 60-second cache.
 */
// @ts-expect-error — JS module, no declaration file
import { sha256Hex } from '../_crypto.js';

export const REFRESH_TTL_SECONDS = 30 * 24 * 3600;
export const REFRESH_ATTEMPT_TTL_SECONDS = 60;
/**
 * How long a rotated refresh token may be presented again by the same client
 * and answered with the successor pair. Bounded to the retry horizon a client
 * reaches from `Retry-After: 5` with backoff; a replay later than this is
 * treated as reuse exactly as before (GHSA-f6gj).
 */
export const REFRESH_REPLAY_GRACE_SECONDS = 60;
/**
 * The consumed record is replaced by an in-flight marker. The marker outlives
 * the attempt claim by the grace window so a claim that ended without a
 * finalize or restore (the consume response was lost, so nothing rotated and
 * nobody holds a successor) reads as an orphan, not as proven replay, until
 * the window closes.
 */
export const REFRESH_ATTEMPT_MARKER_TTL_SECONDS = REFRESH_ATTEMPT_TTL_SECONDS + REFRESH_REPLAY_GRACE_SECONDS;

export type PipelineCommand = (string | number | unknown)[];
export interface PipelineResult { result?: string; error?: string }

export type RefreshRestoreStage =
  | 'persist-family-pointer'
  | 'read-family-revocation'
  | 'client-validation'
  | 'convex-transient'
  | 'store-rotated-token';

export interface RefreshRestoreFailureContext {
  stage: RefreshRestoreStage;
}

export interface RefreshConsumeSuccess {
  kind: 'consumed';
  refreshData: unknown;
  attemptValue: string;
  /** When the claimed token would have expired (epoch ms), if it had a TTL. */
  expiresAtMs?: number | null;
}

export interface RefreshConsumeMiss {
  kind: 'miss';
  recoveryPending: boolean;
  familyId: string | null;
  /**
   * The refresh key still holds an in-flight marker. With `recoveryPending`
   * false this is an orphaned claim whose attempt expired without a finalize
   * or restore, which is a lost consume response rather than reuse.
   */
  attemptMarkerPresent: boolean;
}

/**
 * Successor pair stored by a committed rotation, keyed by the hash of the
 * token it replaced. Mirrors the token response so a grace replay can answer
 * with exactly what the lost response carried.
 */
export interface RefreshSuccessorRecord {
  kind: 'refresh_successor';
  client_id: string;
  access_token: string;
  refresh_token: string;
  scope: string;
  /** Epoch ms of the rotation, so the replayed `expires_in` is not overstated. */
  issued_at: number;
}

export type RefreshConsumeResult = RefreshConsumeSuccess | RefreshConsumeMiss;

export interface RefreshRecoveryDeps {
  redisBeginRefreshAttempt: (refreshToken: string, attemptId: string) => Promise<RefreshConsumeResult>;
  redisRestoreRefreshAttempt: (
    refreshToken: string,
    attemptValue: string,
    refreshData: unknown,
    familyId: string | null,
    expiresAtMs?: number,
  ) => Promise<boolean>;
  redisFinalizeRefreshAttempt: (refreshToken: string, attemptValue: string) => Promise<boolean>;
  redisProtectFailedRefreshAttempt: (refreshToken: string, attemptValue: string) => Promise<boolean>;
  redisPipeline: (commands: PipelineCommand[]) => Promise<PipelineResult[] | null>;
  captureRestoreFailure: (context: RefreshRestoreFailureContext) => void;
}

export function refreshFamilyPointerKey(refreshToken: string): string {
  return `oauth:famptr:${refreshToken}`;
}

export function refreshFamilyAttemptKey(refreshToken: string): string {
  return `oauth:famattempt:${refreshToken}`;
}

export function refreshFamilyRevocationKey(familyId: string): string {
  return `oauth:famrev:${familyId}`;
}

/** `refreshTokenHash` is the SHA-256 hex of the token that was rotated away. */
export function refreshSuccessorKey(refreshTokenHash: string): string {
  return `oauth:famsucc:${refreshTokenHash}`;
}

/** Stored value of the grace record; `kind` tags it so a parser can reject other shapes. */
export function serializeRefreshSuccessor(record: Omit<RefreshSuccessorRecord, 'kind'>): string {
  return JSON.stringify({ kind: 'refresh_successor', ...record } satisfies RefreshSuccessorRecord);
}

/** Accepts only a complete record; anything else reads as "no grace evidence". */
export function parseRefreshSuccessor(value: unknown): RefreshSuccessorRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<RefreshSuccessorRecord>;
  if (
    record.kind !== 'refresh_successor'
    || typeof record.client_id !== 'string' || !record.client_id
    || typeof record.access_token !== 'string' || !record.access_token
    || typeof record.refresh_token !== 'string' || !record.refresh_token
    || typeof record.scope !== 'string'
    || typeof record.issued_at !== 'number' || !Number.isFinite(record.issued_at)
  ) {
    return null;
  }
  return record as RefreshSuccessorRecord;
}

export function serializeRefreshFamilyPointer(familyId: string): string {
  return JSON.stringify(familyId);
}

function serializeRefreshAttemptMarker(attemptValue: string): string {
  const { attempt_id: attemptId } = JSON.parse(attemptValue) as { attempt_id: string };
  return JSON.stringify({ kind: 'refresh_attempt', attempt_id: attemptId });
}

export function familyIdFromRefreshPointer(pointer: unknown): string | null {
  if (typeof pointer === 'string' && pointer) return pointer;

  // Read object pointers written by the briefly deployed version of this
  // handler, but never write them. This makes the migration one-way while
  // preserving rollback compatibility for all new writes.
  if (
    pointer
    && typeof pointer === 'object'
    && typeof (pointer as { family_id?: unknown }).family_id === 'string'
    && (pointer as { family_id: string }).family_id
  ) {
    return (pointer as { family_id: string }).family_id;
  }
  return null;
}

function pipelineOk(results: PipelineResult[] | null): boolean {
  return Array.isArray(results) && results.every((result) => result?.result === 'OK');
}

export async function persistRefreshFamilyPointer(
  deps: Pick<RefreshRecoveryDeps, 'redisPipeline'>,
  refreshToken: string,
  familyId: string,
): Promise<boolean> {
  // Preserve replay evidence for the existing lifetime. Only a legacy token
  // without a pointer gets one with the full TTL.
  const key = refreshFamilyPointerKey(refreshToken);
  const value = serializeRefreshFamilyPointer(familyId);
  const results = await deps.redisPipeline([
    ['SET', key, value, 'EX', REFRESH_TTL_SECONDS, 'NX'],
    ['SET', key, value, 'XX', 'KEEPTTL'],
  ]);
  return Array.isArray(results)
    && results.length === 2
    && results.every((result) => result != null && !result.error)
    && results[1]?.result === 'OK';
}

export async function markRefreshFamilyRevoked(
  deps: Pick<RefreshRecoveryDeps, 'redisPipeline'>,
  familyId: string,
): Promise<boolean> {
  return pipelineOk(await deps.redisPipeline([
    ['SET', refreshFamilyRevocationKey(familyId), '1', 'EX', REFRESH_TTL_SECONDS],
  ]));
}

export async function restoreRefreshAttempt(
  deps: RefreshRecoveryDeps,
  refreshToken: string,
  attemptValue: string,
  refreshData: unknown,
  familyId: string | null,
  stage: RefreshRestoreStage,
  expiresAtMs?: number | null,
): Promise<boolean> {
  try {
    if (
      await deps.redisRestoreRefreshAttempt(
        refreshToken,
        attemptValue,
        refreshData,
        familyId,
        expiresAtMs ?? undefined,
      )
    ) {
      return true;
    }
  } catch {
    // The attempt record remains non-revocation-eligible if Redis did not
    // commit. If Redis committed but the response was lost, the refresh token
    // is restored and a retry can safely create a new attempt.
  }

  // A normal in-flight claim is deliberately short-lived so a failed
  // finalization cannot suppress replay detection for the refresh-token TTL.
  // Only a confirmed recovery failure extends the claim. This compare-and-set
  // does nothing after a lost restore response because a committed restore
  // already removed the attempt atomically.
  try {
    await deps.redisProtectFailedRefreshAttempt(refreshToken, attemptValue);
  } catch {
    // Redis may still hold the short in-flight claim. Do not weaken the
    // retryable response or remove the canonical replay pointer.
  }

  try {
    deps.captureRestoreFailure({ stage });
  } catch {
    // Observability must not change the retryable OAuth response.
  }
  return false;
}

export async function finalizeRefreshAttempt(
  deps: Pick<RefreshRecoveryDeps, 'redisFinalizeRefreshAttempt'>,
  refreshToken: string,
  attemptValue: string,
): Promise<boolean> {
  try {
    return await deps.redisFinalizeRefreshAttempt(refreshToken, attemptValue);
  } catch {
    return false;
  }
}

function redisConfig(): { url: string; token: string } {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis not configured');
  return { url, token };
}

async function rawRedisEval(
  script: string,
  keys: string[],
  args: Array<string | number>,
): Promise<unknown> {
  const { url, token } = redisConfig();
  const resp = await fetch(`${url}/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'worldmonitor-edge/1.0',
    },
    body: JSON.stringify(['EVAL', script, String(keys.length), ...keys, ...args]),
    signal: AbortSignal.timeout(3_000),
  });
  if (!resp.ok) throw new Error(`Redis HTTP ${resp.status}`);
  const data = (await resp.json().catch(() => null)) as { result?: unknown; error?: string } | null;
  if (data?.error) throw new Error(`Redis EVAL failed: ${data.error}`);
  if (!data || !Object.prototype.hasOwnProperty.call(data, 'result')) {
    throw new Error('Redis EVAL returned an invalid response');
  }
  return data.result;
}

function parseStoredJson(value: unknown): unknown {
  if (typeof value !== 'string') throw new Error('Redis returned an invalid stored value');
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('Redis returned malformed JSON');
  }
}

/**
 * Consume a refresh token and open its recovery attempt in one script. A hit
 * returns the record and its remaining lifetime; a miss reports whether an
 * attempt is pending, the family pointer, and whether the in-flight marker is
 * still present (an orphaned claim when no attempt is pending).
 */
export async function rawRedisBeginRefreshAttempt(
  refreshToken: string,
  attemptId: string,
): Promise<RefreshConsumeResult> {
  const refreshKey = `oauth:refresh:${refreshToken}`;
  const attemptKey = refreshFamilyAttemptKey(refreshToken);
  const pointerKey = refreshFamilyPointerKey(refreshToken);
  const attemptValue = JSON.stringify({ attempt_id: attemptId });
  const attemptMarker = serializeRefreshAttemptMarker(attemptValue);
  const script = [
    "local value = redis.call('GET', KEYS[1])",
    'if value then',
    '  local ok, decoded = pcall(cjson.decode, value)',
    "  if ok and type(decoded) == 'table' and decoded.kind == 'refresh_attempt' then",
    "    return {0, redis.call('EXISTS', KEYS[2]), redis.call('GET', KEYS[3]) or false, 1}",
    '  end',
    "  local ttl = redis.call('PTTL', KEYS[1])",
    '  local expiresAt = -1',
    '  if ttl >= 0 then',
    "    local now = redis.call('TIME')",
    '    expiresAt = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000) + ttl',
    '  end',
    "  redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[3])",
    "  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[4])",
    '  return {1, value, expiresAt}',
    'end',
    "return {0, redis.call('EXISTS', KEYS[2]), redis.call('GET', KEYS[3]) or false, 0}",
  ].join('\n');
  const result = await rawRedisEval(
    script,
    [refreshKey, attemptKey, pointerKey],
    [attemptValue, attemptMarker, REFRESH_ATTEMPT_TTL_SECONDS, REFRESH_ATTEMPT_MARKER_TTL_SECONDS],
  );

  if (!Array.isArray(result) || (result[0] !== 0 && result[0] !== 1)) {
    throw new Error('Redis refresh-attempt consume returned an invalid response');
  }
  if (result[0] === 1) {
    if (!Number.isSafeInteger(result[2]) || result[2] < -1) {
      throw new Error('Redis refresh-attempt consume returned an invalid expiry');
    }
    return {
      kind: 'consumed',
      refreshData: parseStoredJson(result[1]),
      attemptValue,
      expiresAtMs: result[2] === -1 ? null : result[2],
    };
  }
  return {
    kind: 'miss',
    recoveryPending: result[1] === 1,
    familyId: result[2] ? familyIdFromRefreshPointer(parseStoredJson(result[2])) : null,
    attemptMarkerPresent: result[3] === 1,
  };
}

/**
 * Put a consumed refresh token back, fenced on the attempt that consumed it.
 * A restore means the rotation did not happen, so any successor record the
 * attempt's storage pipeline may have committed before reporting failure is
 * removed too: otherwise a later consumer of the restored token and an
 * overlapping grace replay would hand out two different live pairs.
 */
export async function rawRedisRestoreRefreshAttempt(
  refreshToken: string,
  attemptValue: string,
  refreshData: unknown,
  familyId: string | null,
  expiresAtMs?: number,
): Promise<boolean> {
  // Redis owns the deadline so HTTP latency and application clock skew cannot
  // extend it. Legacy persistent records fall back to the pointer's lifetime.
  const script = [
    "if redis.call('GET', KEYS[3]) ~= ARGV[1] then return 0 end",
    "redis.call('DEL', KEYS[4])",
    'local expiresAt = tonumber(ARGV[5])',
    'local ttl',
    'if expiresAt then',
    "  local now = redis.call('TIME')",
    '  ttl = expiresAt - (tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000))',
    'else',
    "  ttl = redis.call('PTTL', KEYS[2])",
    '  if ttl < 0 then ttl = tonumber(ARGV[4]) * 1000 end',
    'end',
    'if ttl <= 0 then',
    "  redis.call('DEL', KEYS[1], KEYS[3])",
    '  return 1',
    'end',
    "redis.call('SET', KEYS[1], ARGV[2], 'PX', ttl)",
    "if ARGV[3] ~= '' then redis.call('SET', KEYS[2], ARGV[3], 'PX', ttl) end",
    "redis.call('DEL', KEYS[3])",
    'return 1',
  ].join('\n');
  const result = await rawRedisEval(
    script,
    [
      `oauth:refresh:${refreshToken}`,
      refreshFamilyPointerKey(refreshToken),
      refreshFamilyAttemptKey(refreshToken),
      refreshSuccessorKey(await sha256Hex(refreshToken)),
    ],
    [
      attemptValue,
      JSON.stringify(refreshData),
      familyId ? serializeRefreshFamilyPointer(familyId) : '',
      REFRESH_TTL_SECONDS,
      expiresAtMs ?? '',
    ],
  );
  if (result !== 0 && result !== 1) throw new Error('Redis refresh-attempt restore returned an invalid response');
  return result === 1;
}

export async function rawRedisFinalizeRefreshAttempt(
  refreshToken: string,
  attemptValue: string,
): Promise<boolean> {
  const script = [
    "if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end",
    "if redis.call('GET', KEYS[1]) == ARGV[2] then redis.call('DEL', KEYS[1]) end",
    "redis.call('DEL', KEYS[2])",
    'return 1',
  ].join('\n');
  const result = await rawRedisEval(
    script,
    [`oauth:refresh:${refreshToken}`, refreshFamilyAttemptKey(refreshToken)],
    [attemptValue, serializeRefreshAttemptMarker(attemptValue)],
  );
  if (result !== 0 && result !== 1) throw new Error('Redis refresh-attempt finalize returned an invalid response');
  return result === 1;
}

export async function rawRedisProtectFailedRefreshAttempt(
  refreshToken: string,
  attemptValue: string,
): Promise<boolean> {
  const attemptId = (JSON.parse(attemptValue) as { attempt_id: string }).attempt_id;
  const failedAttemptValue = JSON.stringify({
    attempt_id: attemptId,
    state: 'failed',
  });
  const attemptMarker = JSON.stringify({ kind: 'refresh_attempt', attempt_id: attemptId });
  const failedPointerTombstone = JSON.stringify({ kind: 'refresh_recovery_failed', attempt_id: attemptId });
  const script = [
    "if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end",
    "redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[5])",
    "redis.call('SET', KEYS[3], ARGV[4], 'EX', ARGV[5])",
    "local value = redis.call('GET', KEYS[1])",
    'if not value then',
    "  redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[5])",
    'else',
    '  local ok, decoded = pcall(cjson.decode, value)',
    "  if ok and type(decoded) == 'table' and decoded.kind == 'refresh_attempt' then redis.call('EXPIRE', KEYS[1], ARGV[5]) end",
    'end',
    'return 1',
  ].join('\n');
  const result = await rawRedisEval(
    script,
    [
      `oauth:refresh:${refreshToken}`,
      refreshFamilyAttemptKey(refreshToken),
      refreshFamilyPointerKey(refreshToken),
    ],
    [attemptValue, failedAttemptValue, attemptMarker, failedPointerTombstone, REFRESH_TTL_SECONDS],
  );
  if (result !== 0 && result !== 1) throw new Error('Redis failed-attempt protect returned an invalid response');
  return result === 1;
}
