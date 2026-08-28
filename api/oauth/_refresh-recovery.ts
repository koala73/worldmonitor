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
 */

export const REFRESH_TTL_SECONDS = 604800;
export const REFRESH_ATTEMPT_TTL_SECONDS = 60;

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
}

export interface RefreshConsumeMiss {
  kind: 'miss';
  recoveryPending: boolean;
  familyId: string | null;
}

export type RefreshConsumeResult = RefreshConsumeSuccess | RefreshConsumeMiss;

export interface RefreshRecoveryDeps {
  redisBeginRefreshAttempt: (refreshToken: string, attemptId: string) => Promise<RefreshConsumeResult>;
  redisRestoreRefreshAttempt: (
    refreshToken: string,
    attemptValue: string,
    refreshData: unknown,
    familyId: string | null,
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
  return pipelineOk(await deps.redisPipeline([
    [
      'SET',
      refreshFamilyPointerKey(refreshToken),
      serializeRefreshFamilyPointer(familyId),
      'EX',
      REFRESH_TTL_SECONDS,
    ],
  ]));
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
): Promise<boolean> {
  try {
    if (
      await deps.redisRestoreRefreshAttempt(
        refreshToken,
        attemptValue,
        refreshData,
        familyId,
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
    "    return {0, redis.call('EXISTS', KEYS[2]), redis.call('GET', KEYS[3]) or false}",
    '  end',
    "  redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[3])",
    "  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])",
    '  return {1, value}',
    'end',
    "return {0, redis.call('EXISTS', KEYS[2]), redis.call('GET', KEYS[3]) or false}",
  ].join('\n');
  const result = await rawRedisEval(
    script,
    [refreshKey, attemptKey, pointerKey],
    [attemptValue, attemptMarker, REFRESH_ATTEMPT_TTL_SECONDS],
  );

  if (!Array.isArray(result) || (result[0] !== 0 && result[0] !== 1)) {
    throw new Error('Redis refresh-attempt consume returned an invalid response');
  }
  if (result[0] === 1) {
    return { kind: 'consumed', refreshData: parseStoredJson(result[1]), attemptValue };
  }
  return {
    kind: 'miss',
    recoveryPending: result[1] === 1,
    familyId: result[2] ? familyIdFromRefreshPointer(parseStoredJson(result[2])) : null,
  };
}

export async function rawRedisRestoreRefreshAttempt(
  refreshToken: string,
  attemptValue: string,
  refreshData: unknown,
  familyId: string | null,
): Promise<boolean> {
  const script = [
    "if redis.call('GET', KEYS[3]) ~= ARGV[1] then return 0 end",
    "redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[4])",
    "if ARGV[3] ~= '' then redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4]) end",
    "redis.call('DEL', KEYS[3])",
    'return 1',
  ].join('\n');
  const result = await rawRedisEval(
    script,
    [
      `oauth:refresh:${refreshToken}`,
      refreshFamilyPointerKey(refreshToken),
      refreshFamilyAttemptKey(refreshToken),
    ],
    [
      attemptValue,
      JSON.stringify(refreshData),
      familyId ? serializeRefreshFamilyPointer(familyId) : '',
      REFRESH_TTL_SECONDS,
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
