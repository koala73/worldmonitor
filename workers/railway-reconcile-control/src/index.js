export const LEASE_DURATION_MS = 30 * 60 * 1000;
export const MUTATION_JOB_BUDGET_MS = 13 * 60 * 1000;
export const TERMINATION_GRACE_MS = 5 * 60 * 1000;
export const NETWORK_CLOCK_MARGIN_MS = 60 * 1000;
export const SAFETY_MARGIN_MS = 6 * 60 * 1000;
export const AUTH_CLOCK_WINDOW_MS = 5 * 60 * 1000;
const AUTH_TIMESTAMP_GRANULARITY_MS = 1_000;

const MAX_REQUEST_BODY_BYTES = 16 * 1024;
const MAX_AUTH_NONCES = 2048;
const MIN_HMAC_SECRET_BYTES = 32;
const MAX_HMAC_SECRET_BYTES = 1024;
const META_KEY = 'control-meta:v1';
const AUTH_NONCES_KEY_PREFIX = 'auth-nonces:v1:';
const MAX_ACTIVE_DISPATCH_HOLDS = 64;
const MAX_SUPERSEDED_RUNS = 64;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

const SECRET_BINDINGS = Object.freeze({
  mutation: 'MUTATION_HMAC_SECRET',
  verifier: 'VERIFIER_HMAC_SECRET',
  watchdog: 'WATCHDOG_HMAC_SECRET',
  operator: 'OPERATOR_HMAC_SECRET',
});

const ROUTES = Object.freeze({
  '/v1/mutation/acquire': { role: 'mutation', action: 'acquire' },
  '/v1/mutation/prepare': { role: 'mutation', action: 'prepare' },
  '/v1/mutation/assert': { role: 'mutation', action: 'assertOwner' },
  '/v1/mutation/start': { role: 'mutation', action: 'start' },
  '/v1/mutation/bind-result': { role: 'mutation', action: 'bindResult' },
  '/v1/mutation/release': { role: 'mutation', action: 'release' },
  '/v1/mutation/abort': { role: 'mutation', action: 'abort' },
  '/v1/verifier/accept': { role: 'verifier', action: 'accept' },
  '/v1/verifier/fail': { role: 'verifier', action: 'failVerification' },
  '/v1/watchdog/status': { role: 'watchdog', action: 'status' },
  '/v1/watchdog/dispatch-hold': { role: 'watchdog', action: 'dispatchHold' },
  '/v1/watchdog/bind-run': { role: 'watchdog', action: 'bindRun' },
  '/v1/watchdog/dispatch-rejected': { role: 'watchdog', action: 'dispatchRejected' },
  '/v1/operator/resolve': { role: 'operator', action: 'operatorResolve' },
});

const VERIFIER_FAILURE_REASONS = new Set([
  'TERMINAL_FAILURE',
  'STALLED',
  'UNKNOWN_STATUS',
  'UNREADABLE_HISTORY',
  'PARTIAL_MUTATION',
  'AMBIGUOUS_MUTATION',
  'CONVERGENCE_TIMEOUT',
  'VERIFIER_CONTRACT_FAILURE',
]);

const OPERATOR_DECISIONS = new Set([
  'resolve_pre_mutation_hold',
  'accept_observed_convergence',
  'authorize_current_main_retry',
]);

const PRE_MUTATION_ABORT_REASONS = new Set([
  'MAIN_MOVED',
  'GATE_NOT_GREEN',
  'PLAN_ABORTED',
  'NO_LONGER_REQUIRED',
]);

if (
  LEASE_DURATION_MS
  <= MUTATION_JOB_BUDGET_MS
    + TERMINATION_GRACE_MS
    + NETWORK_CLOCK_MARGIN_MS
    + SAFETY_MARGIN_MS
) {
  throw new Error('Unsafe Railway reconciliation lease duration');
}

class ControlError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function reject(status, code) {
  throw new ControlError(status, code);
}

function requireIndependentRoleSecrets(env) {
  const secrets = {};
  const seen = new Set();
  for (const [role, binding] of Object.entries(SECRET_BINDINGS)) {
    const secret = env[binding];
    const byteLength = typeof secret === 'string'
      ? textEncoder.encode(secret).byteLength
      : 0;
    if (
      byteLength < MIN_HMAC_SECRET_BYTES
      || byteLength > MAX_HMAC_SECRET_BYTES
      || seen.has(secret)
    ) {
      reject(503, 'AUTH_UNAVAILABLE');
    }
    seen.add(secret);
    secrets[role] = secret;
  }
  return secrets;
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

function errorResponse(status, code) {
  const messages = {
    AUTH_INVALID: 'control authentication failed',
    AUTH_ROLE_FORBIDDEN: 'credential role is not allowed on this route',
    AUTH_STALE: 'control authentication timestamp is outside the allowed window',
    AUTH_REPLAY: 'control authentication nonce was already used',
    AUTH_UNAVAILABLE: 'control authentication is unavailable',
    AUTH_NONCE_CAPACITY: 'control authentication nonce capacity is temporarily exhausted',
    CONTROL_PLANE_UNAVAILABLE: 'control plane configuration is unavailable',
    STATE_UNAVAILABLE: 'control state is unavailable',
    LEASE_HELD: 'another owner holds the lease',
    RUN_ALREADY_ACQUIRED: 'this workflow run already acquired its non-renewable lease',
    LEASE_NOT_ACTIVE: 'the lease is not active',
    LEASE_OWNER_MISMATCH: 'lease owner does not match',
    LEASE_CAPABILITY_MISMATCH: 'lease capability does not match',
    LEASE_EXPIRED: 'the lease has expired',
    LEASE_TTL_INSUFFICIENT: 'the lease has insufficient remaining time',
    MUTATION_BARRIER_ACTIVE: 'a mutation uncertainty barrier is active',
    DISPATCH_HOLD_ACTIVE: 'an unresolved dispatch hold is active',
    DISPATCH_HOLD_NOT_FOUND: 'dispatch hold was not found',
    DISPATCH_HOLD_ID_REUSED: 'dispatch hold identifier was already used',
    VERIFICATION_PENDING: 'a no-mutation attempt is awaiting strict verification',
    INVALID_ATTEMPT_TRANSITION: 'attempt transition is not allowed',
    INTENT_DIGEST_MISMATCH: 'intent digest does not match',
    RESULT_DIGEST_MISMATCH: 'result digest does not match',
    HEAD_SHA_MISMATCH: 'head SHA does not match',
    BARRIER_MISMATCH: 'mutation barrier does not match the attempt',
    RESULT_NOT_BOUND: 'attempt result is not bound',
    RESULT_ALREADY_BOUND: 'attempt result is already bound',
    LEASE_STILL_ACTIVE: 'the attempt lease is still active',
    ATTEMPT_SUPERSEDED: 'the attempt has been superseded',
    UNKNOWN_PROTOCOL_VERSION: 'control protocol version is unsupported',
    ROUTE_NOT_FOUND: 'control route was not found',
    METHOD_NOT_ALLOWED: 'HTTP method is not allowed on this route',
    CONTENT_TYPE_REQUIRED: 'application/json content type is required',
    REQUEST_TOO_LARGE: 'control request body is too large',
    MALFORMED_JSON: 'control request body is malformed JSON',
    UNSUPPORTED_URL: 'query strings and fragments are not supported',
    UNSUPPORTED_FIELD: 'control request contains an unsupported field',
    NOT_IMPLEMENTED: 'control route is not implemented',
  };
  const message = messages[code] || 'control request failed closed';
  return jsonResponse(status, {
    version: 1,
    ok: false,
    outcome: code,
    error: { code, message },
  });
}

async function readBoundedRequestBody(request) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BODY_BYTES) {
      await reader.cancel('request body exceeds the control-plane limit').catch(() => {});
      reject(413, 'REQUEST_TOO_LARGE');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function successResponse(status, outcome, data) {
  return jsonResponse(status, { version: 1, ok: true, outcome, data });
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function sha256Hex(value) {
  const bytes = typeof value === 'string' ? textEncoder.encode(value) : value;
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

async function verifyHmac(secret, canonical, providedHex) {
  const signature = hexToBytes(providedHex);
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify('HMAC', key, signature, textEncoder.encode(canonical));
}

function assertObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    reject(400, 'MALFORMED_JSON');
  }
}

function assertAllowedKeys(value, allowed) {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    reject(400, 'UNSUPPORTED_FIELD');
  }
}

function requireIdentifier(value, code, maxLength = 128) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maxLength
    || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value)
  ) {
    reject(400, code);
  }
  return value;
}

function requireHeadSha(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    reject(400, 'INVALID_HEAD_SHA');
  }
  return value;
}

function requireDigest(value, code) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    reject(400, code);
  }
  return value;
}

function requireMillisecondIso(value, code) {
  if (
    typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    reject(400, code);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    reject(400, code);
  }
  return { value, milliseconds };
}

function readSupersededRuns(value) {
  if (!Array.isArray(value) || value.length > MAX_SUPERSEDED_RUNS) {
    reject(503, 'STATE_UNAVAILABLE');
  }
  const seen = new Set();
  return value.map((run) => {
    if (
      !run
      || typeof run !== 'object'
      || Array.isArray(run)
      || JSON.stringify(Object.keys(run).sort()) !== '["runAttempt","runId"]'
      || typeof run.runId !== 'string'
      || run.runId.length < 1
      || run.runId.length > 24
      || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(run.runId)
      || !Number.isInteger(run.runAttempt)
      || run.runAttempt < 1
      || run.runAttempt > 1_000
    ) {
      reject(503, 'STATE_UNAVAILABLE');
    }
    const key = `${run.runId}\n${run.runAttempt}`;
    if (seen.has(key)) reject(503, 'STATE_UNAVAILABLE');
    seen.add(key);
    return { runId: run.runId, runAttempt: run.runAttempt };
  });
}

function appendSupersededRun(value, runId, runAttempt) {
  const runs = readSupersededRuns(value);
  if (runId === null) return runs;
  if (runs.some((run) => run.runId === runId && run.runAttempt === runAttempt)) return runs;
  if (runs.length >= MAX_SUPERSEDED_RUNS) reject(409, 'SUPERSEDED_RUNS_LIMIT');
  return [...runs, { runId, runAttempt }];
}

function requireCapability(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    reject(400, 'INVALID_LEASE_CAPABILITY');
  }
  return value;
}

function constantTimeHexEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) {
    return false;
  }
  let different = 0;
  for (let index = 0; index < left.length; index += 1) {
    different |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return different === 0;
}

function attemptKey(attemptId) {
  return `attempt:${attemptId}`;
}

function runAcquisitionKey(runId, runAttempt) {
  return `run-acquisition:${runId}:${runAttempt}`;
}

function dispatchHoldKey(recoveryAttemptId) {
  return `dispatch-hold:${recoveryAttemptId}`;
}

function operatorResolutionKey(operationId) {
  return `operator-resolution:${operationId}`;
}

function initialMeta() {
  return {
    schemaVersion: 1,
    generation: 0,
    latestAttemptId: null,
    currentLease: null,
    barrier: null,
    lastAccepted: null,
    activeDispatchHoldIds: [],
  };
}

async function getMeta(storage) {
  const meta = await storage.get(META_KEY);
  if (meta === undefined) return initialMeta();
  if (
    !meta
    || meta.schemaVersion !== 1
    || !Number.isSafeInteger(meta.generation)
    || meta.generation < 0
    || !Array.isArray(meta.activeDispatchHoldIds)
  ) {
    reject(503, 'STATE_UNAVAILABLE');
  }
  return meta;
}

async function getAttempt(storage, attemptId) {
  if (!attemptId) return null;
  const attempt = await storage.get(attemptKey(attemptId));
  if (!attempt || attempt.attemptId !== attemptId || attempt.version !== 1) {
    reject(503, 'STATE_UNAVAILABLE');
  }
  return attempt;
}

function publicAttempt(attempt) {
  if (!attempt) return null;
  const {
    attemptId,
    generation,
    headSha,
    ownerId,
    state,
    createdAt,
    leaseExpiresAt,
    intentDigest = null,
    resultKind = null,
    resultDigest = null,
    closedReason = null,
    acceptedAt = null,
    supersedesAttemptId = null,
    actor = null,
    approver = null,
    reason = null,
    evidence = null,
    evidenceDigest = null,
    decision = null,
    supersedesDispatchHoldId = null,
    recoveryAttemptId = null,
    runId = null,
    runAttempt = null,
    triggeringActor = null,
    operatorRunId = null,
    operatorRunAttempt = null,
    evidenceId = null,
    runEvidenceId = null,
    environmentEvidenceId = null,
    gateStatusId = null,
    gateUpdatedAt = null,
    priorCreatedAt = null,
    authorizationHeadSha = null,
    supersededRuns = [],
  } = attempt;
  return {
    version: 1,
    attemptId,
    generation,
    headSha,
    ownerId,
    state,
    createdAt,
    leaseExpiresAt,
    intentDigest,
    resultKind,
    resultDigest,
    closedReason,
    acceptedAt,
    supersedesAttemptId,
    actor,
    approver,
    reason,
    evidence,
    evidenceDigest,
    decision,
    supersedesDispatchHoldId,
    recoveryAttemptId,
    runId,
    runAttempt,
    triggeringActor,
    operatorRunId,
    operatorRunAttempt,
    evidenceId,
    runEvidenceId,
    environmentEvidenceId,
    gateStatusId,
    gateUpdatedAt,
    priorCreatedAt,
    authorizationHeadSha,
    supersededRuns: readSupersededRuns(supersededRuns),
  };
}

function publicLease(lease, now) {
  if (!lease) return null;
  return {
    attemptId: lease.attemptId,
    generation: lease.generation,
    ownerId: lease.ownerId,
    headSha: lease.headSha,
    acquiredAt: lease.acquiredAt,
    expiresAt: lease.expiresAt,
    remainingTtlMs: Math.max(0, lease.expiresAt - now),
  };
}

function publicDispatchHold(hold) {
  if (!hold) return null;
  const {
    recoveryAttemptId,
    headSha,
    state,
    createdAt,
    sourceHeadSha = null,
    sourceRunId = null,
    sourceRunAttempt = null,
    runId = null,
    runAttempt = null,
    boundAt = null,
    admittedAt = null,
    linkedAttemptId = null,
    reason = null,
    evidenceDigest = null,
    closedAt = null,
    supersededRuns = [],
  } = hold;
  return {
    version: 1,
    recoveryAttemptId,
    headSha,
    state,
    createdAt,
    sourceHeadSha,
    sourceRunId,
    sourceRunAttempt,
    runId,
    runAttempt,
    boundAt,
    admittedAt,
    linkedAttemptId,
    reason,
    evidenceDigest,
    closedAt,
    supersededRuns: readSupersededRuns(supersededRuns),
  };
}

async function getDispatchHold(storage, recoveryAttemptId) {
  const hold = await storage.get(dispatchHoldKey(recoveryAttemptId));
  if (!hold || hold.version !== 1 || hold.recoveryAttemptId !== recoveryAttemptId) {
    reject(404, 'DISPATCH_HOLD_NOT_FOUND');
  }
  return hold;
}

async function consumeNonce(storage, role, nonceHash, expiresAt, now) {
  const nonceKey = `${AUTH_NONCES_KEY_PREFIX}${role}`;
  const stored = await storage.get(nonceKey);
  if (stored !== undefined && !Array.isArray(stored)) {
    reject(503, 'STATE_UNAVAILABLE');
  }
  const live = (stored || []).filter((entry) => (
    entry
    && typeof entry.hash === 'string'
    && Number.isSafeInteger(entry.expiresAt)
    && entry.expiresAt >= now
  ));
  if (live.some((entry) => entry.hash === nonceHash)) {
    reject(409, 'AUTH_REPLAY');
  }
  if (live.length >= MAX_AUTH_NONCES) {
    reject(503, 'AUTH_NONCE_CAPACITY');
  }
  live.push({ hash: nonceHash, expiresAt });
  await storage.put(nonceKey, live);
}

function newCapability(randomBytes) {
  const bytes = randomBytes(32);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function randomIdentifier(randomUuid) {
  return randomUuid();
}

function isSameRunAttempt(attempt, runId, runAttempt) {
  return attempt.runId === runId && attempt.runAttempt === runAttempt;
}

async function closeSupersededPreMutation(storage, meta, now, runId, runAttempt) {
  if (!meta.latestAttemptId) return null;
  const previous = await getAttempt(storage, meta.latestAttemptId);
  if (isSameRunAttempt(previous, runId, runAttempt)) reject(409, 'RUN_ALREADY_ACQUIRED');
  if (previous.state === 'PRE_MUTATION_ABORTED') return previous;
  if (!['LEASED', 'PREPARED'].includes(previous.state)) return null;
  if (previous.state === 'PREPARED' && previous.resultKind === 'NO_MUTATION') {
    reject(409, 'VERIFICATION_PENDING');
  }
  previous.state = 'PRE_MUTATION_ABORTED';
  previous.closedReason = 'SUPERSEDED_PRE_MUTATION';
  previous.closedAt = now;
  await storage.put(attemptKey(previous.attemptId), previous);
  return previous;
}

async function acquire(storage, body, now, randomBytes, randomUuid) {
  assertAllowedKeys(body, [
    'version',
    'ownerId',
    'headSha',
    'recoveryAttemptId',
    'runId',
    'runAttempt',
  ]);
  const ownerId = requireIdentifier(body.ownerId, 'INVALID_OWNER_ID');
  const headSha = requireHeadSha(body.headSha);
  if (body.recoveryAttemptId !== undefined) {
    requireIdentifier(body.recoveryAttemptId, 'INVALID_RECOVERY_ATTEMPT_ID');
  }
  const runId = requireIdentifier(body.runId, 'INVALID_RUN_ID', 24);
  if (!Number.isInteger(body.runAttempt) || body.runAttempt < 1 || body.runAttempt > 1_000) {
    reject(400, 'INVALID_RUN_ATTEMPT');
  }
  if (ownerId !== `github-run:${runId}:${body.runAttempt}`) {
    reject(400, 'RUN_OWNER_MISMATCH');
  }

  const meta = await getMeta(storage);
  if (await storage.get(runAcquisitionKey(runId, body.runAttempt)) !== undefined) {
    reject(409, 'RUN_ALREADY_ACQUIRED');
  }
  if (meta.barrier) reject(423, 'MUTATION_BARRIER_ACTIVE');
  let admittingHold = null;
  if (meta.activeDispatchHoldIds.length > 0) {
    if (meta.activeDispatchHoldIds.length !== 1 || body.recoveryAttemptId === undefined) {
      reject(409, 'DISPATCH_HOLD_ACTIVE');
    }
    const holdId = meta.activeDispatchHoldIds[0];
    const hold = await getDispatchHold(storage, holdId);
    const runMatches = hold.state === 'RUN_BOUND'
      && hold.runId === runId
      && hold.runAttempt === body.runAttempt;
    if (
      hold.recoveryAttemptId !== body.recoveryAttemptId
      || hold.headSha !== headSha
      || !runMatches
    ) {
      reject(409, 'DISPATCH_HOLD_ACTIVE');
    }
    admittingHold = hold;
  } else if (body.recoveryAttemptId !== undefined) {
    reject(409, 'DISPATCH_HOLD_NOT_FOUND');
  }

  let supersededAttempt = null;
  if (meta.currentLease) {
    if (meta.currentLease.expiresAt > now) reject(409, 'LEASE_HELD');
    const expiredAttempt = await getAttempt(storage, meta.currentLease.attemptId);
    if (isSameRunAttempt(expiredAttempt, runId, body.runAttempt)) {
      reject(409, 'RUN_ALREADY_ACQUIRED');
    }
    if (!['LEASED', 'PREPARED'].includes(expiredAttempt.state)) {
      reject(503, 'STATE_UNAVAILABLE');
    }
    if (expiredAttempt.state === 'PREPARED' && expiredAttempt.resultKind === 'NO_MUTATION') {
      reject(409, 'VERIFICATION_PENDING');
    }
    expiredAttempt.state = 'PRE_MUTATION_ABORTED';
    expiredAttempt.closedReason = 'LEASE_EXPIRED';
    expiredAttempt.closedAt = now;
    await storage.put(attemptKey(expiredAttempt.attemptId), expiredAttempt);
    supersededAttempt = expiredAttempt;
    meta.currentLease = null;
  } else {
    supersededAttempt = await closeSupersededPreMutation(storage, meta, now, runId, body.runAttempt);
  }

  let supersededRuns = admittingHold
    ? readSupersededRuns(admittingHold.supersededRuns)
    : [];
  if (supersededAttempt) {
    for (const run of readSupersededRuns(supersededAttempt.supersededRuns)) {
      supersededRuns = appendSupersededRun(supersededRuns, run.runId, run.runAttempt);
    }
    // A PRE_MUTATION_ABORTED attempt cannot have crossed the provider boundary,
    // so its run does not need to retire a GitHub mutation marker. Keep any
    // inherited mutation lineage, but do not let ordinary lease churn consume
    // the bounded safety history and eventually block all future acquisition.
  }

  const leaseCapability = newCapability(randomBytes);
  const capabilityHash = await sha256Hex(leaseCapability);
  const attemptId = randomIdentifier(randomUuid);
  const generation = meta.generation + 1;
  const expiresAt = now + LEASE_DURATION_MS;
  const attempt = {
    version: 1,
    attemptId,
    generation,
    headSha,
    ownerId,
    state: 'LEASED',
    createdAt: now,
    leaseExpiresAt: expiresAt,
    recoveryAttemptId: body.recoveryAttemptId || null,
    runId,
    runAttempt: body.runAttempt,
    supersededRuns,
  };
  meta.generation = generation;
  meta.latestAttemptId = attemptId;
  meta.currentLease = {
    attemptId,
    generation,
    ownerId,
    headSha,
    capabilityHash,
    acquiredAt: now,
    expiresAt,
  };
  if (admittingHold) {
    admittingHold.state = 'LEASE_ACQUIRED';
    admittingHold.runId = body.runId;
    admittingHold.admittedAt = now;
    admittingHold.linkedAttemptId = attemptId;
    admittingHold.closedAt = now;
    meta.activeDispatchHoldIds = meta.activeDispatchHoldIds.filter(
      (id) => id !== admittingHold.recoveryAttemptId,
    );
    await storage.put(dispatchHoldKey(admittingHold.recoveryAttemptId), admittingHold);
  }
  await storage.put(attemptKey(attemptId), attempt);
  await storage.put(runAcquisitionKey(runId, body.runAttempt), {
    version: 1,
    attemptId,
    acquiredAt: now,
  });
  await storage.put(META_KEY, meta);
  return {
    status: 201,
    outcome: 'LEASE_GRANTED',
    data: {
      attempt: publicAttempt(attempt),
      leaseCapability,
      leaseExpiresAt: expiresAt,
      supersededAttempt: publicAttempt(supersededAttempt),
      dispatchHold: publicDispatchHold(admittingHold),
    },
  };
}

async function assertLeaseOwner(storage, body, now, minTtlMs = 0) {
  const attemptId = requireIdentifier(body.attemptId, 'INVALID_ATTEMPT_ID');
  const ownerId = requireIdentifier(body.ownerId, 'INVALID_OWNER_ID');
  const headSha = requireHeadSha(body.headSha);
  const capability = requireCapability(body.leaseCapability);
  if (!Number.isSafeInteger(minTtlMs) || minTtlMs < 0 || minTtlMs > LEASE_DURATION_MS) {
    reject(400, 'INVALID_MIN_TTL');
  }

  const meta = await getMeta(storage);
  const lease = meta.currentLease;
  if (!lease) reject(409, 'LEASE_NOT_ACTIVE');
  if (
    lease.attemptId !== attemptId
    || lease.ownerId !== ownerId
    || lease.headSha !== headSha
  ) {
    reject(403, 'LEASE_OWNER_MISMATCH');
  }
  const capabilityHash = await sha256Hex(capability);
  if (!constantTimeHexEqual(capabilityHash, lease.capabilityHash)) {
    reject(403, 'LEASE_CAPABILITY_MISMATCH');
  }
  const remainingTtlMs = lease.expiresAt - now;
  if (remainingTtlMs <= 0) reject(409, 'LEASE_EXPIRED');
  if (remainingTtlMs < minTtlMs) reject(409, 'LEASE_TTL_INSUFFICIENT');
  const attempt = await getAttempt(storage, attemptId);
  if (
    attempt.generation !== lease.generation
    || attempt.ownerId !== ownerId
    || attempt.headSha !== headSha
  ) {
    reject(503, 'STATE_UNAVAILABLE');
  }
  return { attempt, lease, meta, remainingTtlMs };
}

async function prepare(storage, body, now) {
  assertAllowedKeys(body, [
    'version',
    'attemptId',
    'ownerId',
    'leaseCapability',
    'headSha',
    'intentDigest',
  ]);
  const intentDigest = requireDigest(body.intentDigest, 'INVALID_INTENT_DIGEST');
  const context = await assertLeaseOwner(storage, body, now);
  if (context.attempt.state !== 'LEASED') reject(409, 'INVALID_ATTEMPT_TRANSITION');
  context.attempt.state = 'PREPARED';
  context.attempt.intentDigest = intentDigest;
  context.attempt.preparedAt = now;
  await storage.put(attemptKey(context.attempt.attemptId), context.attempt);
  return {
    status: 200,
    outcome: 'ATTEMPT_PREPARED',
    data: { attempt: publicAttempt(context.attempt) },
  };
}

async function assertOwner(storage, body, now) {
  assertAllowedKeys(body, [
    'version',
    'attemptId',
    'ownerId',
    'leaseCapability',
    'headSha',
    'minTtlMs',
  ]);
  const context = await assertLeaseOwner(storage, body, now, body.minTtlMs);
  if (!['LEASED', 'PREPARED', 'MUTATION_STARTED'].includes(context.attempt.state)) {
    reject(409, 'INVALID_ATTEMPT_TRANSITION');
  }
  return {
    status: 200,
    outcome: 'LEASE_ASSERTED',
    data: {
      attempt: publicAttempt(context.attempt),
      remainingTtlMs: context.remainingTtlMs,
    },
  };
}

async function startMutation(storage, body, now) {
  assertAllowedKeys(body, [
    'version',
    'attemptId',
    'ownerId',
    'leaseCapability',
    'headSha',
    'intentDigest',
    'minTtlMs',
  ]);
  const intentDigest = requireDigest(body.intentDigest, 'INVALID_INTENT_DIGEST');
  const context = await assertLeaseOwner(storage, body, now, body.minTtlMs);
  if (context.attempt.state !== 'PREPARED') reject(409, 'INVALID_ATTEMPT_TRANSITION');
  if (context.attempt.intentDigest !== intentDigest) reject(409, 'INTENT_DIGEST_MISMATCH');
  if (context.meta.barrier) reject(423, 'MUTATION_BARRIER_ACTIVE');

  context.attempt.state = 'MUTATION_STARTED';
  context.attempt.mutationStartedAt = now;
  context.meta.barrier = {
    version: 1,
    state: 'MUTATION_UNCERTAIN',
    attemptId: context.attempt.attemptId,
    generation: context.attempt.generation,
    headSha: context.attempt.headSha,
    intentDigest,
    raisedAt: now,
  };
  await storage.put(attemptKey(context.attempt.attemptId), context.attempt);
  await storage.put(META_KEY, context.meta);
  return {
    status: 200,
    outcome: 'MUTATION_STARTED',
    data: {
      attempt: publicAttempt(context.attempt),
      barrier: context.meta.barrier,
      remainingTtlMs: context.remainingTtlMs,
    },
  };
}

async function bindResult(storage, body, now) {
  assertAllowedKeys(body, [
    'version',
    'attemptId',
    'ownerId',
    'leaseCapability',
    'headSha',
    'intentDigest',
    'resultKind',
    'resultDigest',
    'minTtlMs',
  ]);
  const intentDigest = requireDigest(body.intentDigest, 'INVALID_INTENT_DIGEST');
  const resultDigest = requireDigest(body.resultDigest, 'INVALID_RESULT_DIGEST');
  if (!['NO_MUTATION', 'MUTATED'].includes(body.resultKind)) {
    reject(400, 'INVALID_RESULT_KIND');
  }
  const context = await assertLeaseOwner(storage, body, now, body.minTtlMs);
  if (context.attempt.intentDigest !== intentDigest) reject(409, 'INTENT_DIGEST_MISMATCH');
  if (context.attempt.resultDigest || context.attempt.resultKind) {
    reject(409, 'RESULT_ALREADY_BOUND');
  }
  if (body.resultKind === 'NO_MUTATION') {
    if (context.attempt.state !== 'PREPARED') reject(409, 'INVALID_ATTEMPT_TRANSITION');
    if (context.meta.barrier) reject(423, 'MUTATION_BARRIER_ACTIVE');
  } else {
    if (context.attempt.state !== 'MUTATION_STARTED') {
      reject(409, 'INVALID_ATTEMPT_TRANSITION');
    }
    if (context.meta.barrier?.attemptId !== context.attempt.attemptId) {
      reject(503, 'STATE_UNAVAILABLE');
    }
  }
  context.attempt.resultKind = body.resultKind;
  context.attempt.resultDigest = resultDigest;
  context.attempt.resultBoundAt = now;
  await storage.put(attemptKey(context.attempt.attemptId), context.attempt);
  return {
    status: 200,
    outcome: 'RESULT_BOUND',
    data: { attempt: publicAttempt(context.attempt) },
  };
}

async function release(storage, body, now) {
  assertAllowedKeys(body, [
    'version',
    'attemptId',
    'ownerId',
    'leaseCapability',
    'headSha',
  ]);
  const context = await assertLeaseOwner(storage, body, now);
  if (context.attempt.state === 'LEASED') {
    context.attempt.state = 'PRE_MUTATION_ABORTED';
    context.attempt.closedReason = 'OWNER_RELEASED_PRE_MUTATION';
    context.attempt.closedAt = now;
  } else if (context.attempt.state === 'PREPARED') {
    if (context.attempt.resultKind !== 'NO_MUTATION') {
      context.attempt.state = 'PRE_MUTATION_ABORTED';
      context.attempt.closedReason = 'OWNER_RELEASED_PRE_MUTATION';
      context.attempt.closedAt = now;
    }
  } else if (context.attempt.state !== 'MUTATION_STARTED') {
    reject(409, 'INVALID_ATTEMPT_TRANSITION');
  }
  context.attempt.leaseReleasedAt = now;
  context.meta.currentLease = null;
  await storage.put(attemptKey(context.attempt.attemptId), context.attempt);
  await storage.put(META_KEY, context.meta);
  return {
    status: 200,
    outcome: 'LEASE_RELEASED',
    data: { attempt: publicAttempt(context.attempt) },
  };
}

async function abortPreMutation(storage, body, now) {
  assertAllowedKeys(body, [
    'version',
    'attemptId',
    'ownerId',
    'leaseCapability',
    'headSha',
    'reason',
  ]);
  if (!PRE_MUTATION_ABORT_REASONS.has(body.reason)) {
    reject(400, 'INVALID_ABORT_REASON');
  }
  const context = await assertLeaseOwner(storage, body, now);
  if (!['LEASED', 'PREPARED'].includes(context.attempt.state)) {
    reject(409, 'INVALID_ATTEMPT_TRANSITION');
  }
  if (context.attempt.resultKind === 'NO_MUTATION') reject(409, 'VERIFICATION_PENDING');
  context.attempt.state = 'PRE_MUTATION_ABORTED';
  context.attempt.closedReason = body.reason;
  context.attempt.closedAt = now;
  context.meta.currentLease = null;
  await storage.put(attemptKey(context.attempt.attemptId), context.attempt);
  await storage.put(META_KEY, context.meta);
  return {
    status: 200,
    outcome: 'PRE_MUTATION_ABORTED',
    data: { attempt: publicAttempt(context.attempt) },
  };
}

async function accept(storage, body, now, operationDigest) {
  assertAllowedKeys(body, [
    'version',
    'attemptId',
    'headSha',
    'intentDigest',
    'resultDigest',
  ]);
  const attemptId = requireIdentifier(body.attemptId, 'INVALID_ATTEMPT_ID');
  const headSha = requireHeadSha(body.headSha);
  const intentDigest = requireDigest(body.intentDigest, 'INVALID_INTENT_DIGEST');
  const resultDigest = requireDigest(body.resultDigest, 'INVALID_RESULT_DIGEST');
  const meta = await getMeta(storage);
  const attempt = await getAttempt(storage, attemptId);
  if (attempt.headSha !== headSha) reject(409, 'HEAD_SHA_MISMATCH');
  if (attempt.intentDigest !== intentDigest) reject(409, 'INTENT_DIGEST_MISMATCH');
  if (attempt.resultDigest !== resultDigest) reject(409, 'RESULT_DIGEST_MISMATCH');
  if (
    attempt.state === 'TERMINAL_ACCEPTED'
    && attempt.acceptOperationDigest === operationDigest
    && attempt.acceptedRecord
  ) {
    return {
      status: 200,
      outcome: 'TERMINAL_ACCEPTED',
      data: {
        attempt: publicAttempt(attempt),
        barrier: meta.barrier,
        lastAccepted: attempt.acceptedRecord,
      },
    };
  }
  if (meta.latestAttemptId !== attemptId || attempt.generation !== meta.generation) {
    reject(409, 'ATTEMPT_SUPERSEDED');
  }
  if (meta.currentLease?.attemptId === attemptId) {
    if (meta.currentLease.expiresAt > now) reject(409, 'LEASE_STILL_ACTIVE');
    // A lost release response must not turn the non-renewing lease into a
    // permanent verifier lock. Once expiry has removed every mutation right,
    // exact digest-bound terminal proof may retire the stale lease record and
    // finalize this same generation. The attempt and any mutation barrier stay
    // intact until the verifier decision below succeeds.
    meta.currentLease = null;
  }

  if (attempt.resultKind === 'NO_MUTATION') {
    if (attempt.state !== 'PREPARED') reject(409, 'INVALID_ATTEMPT_TRANSITION');
    if (meta.barrier) reject(423, 'MUTATION_BARRIER_ACTIVE');
  } else if (attempt.resultKind === 'MUTATED') {
    if (attempt.state !== 'MUTATION_STARTED') {
      reject(409, 'INVALID_ATTEMPT_TRANSITION');
    }
    if (
      meta.barrier?.attemptId !== attemptId
      || meta.barrier.generation !== attempt.generation
      || meta.barrier.headSha !== headSha
      || meta.barrier.intentDigest !== intentDigest
    ) {
      reject(409, 'BARRIER_MISMATCH');
    }
  } else {
    reject(409, 'RESULT_NOT_BOUND');
  }

  const resultKind = attempt.resultKind;
  attempt.state = 'TERMINAL_ACCEPTED';
  attempt.acceptedAt = now;
  attempt.closedReason = 'STRICT_VERIFIER_ACCEPTED';
  attempt.closedAt = now;
  meta.lastAccepted = {
    version: 1,
    attemptId,
    generation: attempt.generation,
    headSha,
    intentDigest,
    resultDigest,
    resultKind,
    acceptedAt: now,
    runId: attempt.runId ?? null,
    runAttempt: attempt.runAttempt ?? null,
    supersededRuns: readSupersededRuns(attempt.supersededRuns),
  };
  attempt.acceptOperationDigest = operationDigest;
  attempt.acceptedRecord = meta.lastAccepted;
  if (resultKind === 'MUTATED') meta.barrier = null;
  await storage.put(attemptKey(attemptId), attempt);
  await storage.put(META_KEY, meta);
  return {
    status: 200,
    outcome: 'TERMINAL_ACCEPTED',
    data: {
      attempt: publicAttempt(attempt),
      barrier: meta.barrier,
      lastAccepted: meta.lastAccepted,
    },
  };
}

async function failVerification(storage, body, now) {
  assertAllowedKeys(body, [
    'version',
    'attemptId',
    'headSha',
    'intentDigest',
    'resultDigest',
    'reason',
  ]);
  const attemptId = requireIdentifier(body.attemptId, 'INVALID_ATTEMPT_ID');
  const headSha = requireHeadSha(body.headSha);
  const intentDigest = requireDigest(body.intentDigest, 'INVALID_INTENT_DIGEST');
  const resultDigest = body.resultDigest === undefined
    ? null
    : requireDigest(body.resultDigest, 'INVALID_RESULT_DIGEST');
  if (!VERIFIER_FAILURE_REASONS.has(body.reason)) reject(400, 'INVALID_FAILURE_REASON');

  const meta = await getMeta(storage);
  const attempt = await getAttempt(storage, attemptId);
  if (attempt.headSha !== headSha) reject(409, 'HEAD_SHA_MISMATCH');
  if (attempt.intentDigest !== intentDigest) reject(409, 'INTENT_DIGEST_MISMATCH');
  if (attempt.resultDigest !== undefined && attempt.resultDigest !== resultDigest) {
    reject(409, 'RESULT_DIGEST_MISMATCH');
  }
  if (attempt.resultDigest === undefined && resultDigest !== null) {
    reject(409, 'RESULT_DIGEST_MISMATCH');
  }
  if (meta.latestAttemptId !== attemptId || attempt.generation !== meta.generation) {
    reject(409, 'ATTEMPT_SUPERSEDED');
  }
  if (meta.currentLease?.attemptId === attemptId) {
    if (meta.currentLease.expiresAt > now) reject(409, 'LEASE_STILL_ACTIVE');
    // Failure finalization has the same lost-release recovery boundary as
    // acceptance: expiry removes mutation authority, but does not clear a
    // mutation barrier or rewrite the attempt's evidence.
    meta.currentLease = null;
  }

  let outcome;
  if (attempt.state === 'MUTATION_STARTED') {
    if (
      meta.barrier?.attemptId !== attemptId
      || meta.barrier.generation !== attempt.generation
      || meta.barrier.headSha !== headSha
      || meta.barrier.intentDigest !== intentDigest
    ) {
      reject(409, 'BARRIER_MISMATCH');
    }
    attempt.state = 'MANUAL_REQUIRED';
    outcome = 'MANUAL_REQUIRED';
  } else if (attempt.state === 'PREPARED' && attempt.resultKind === 'NO_MUTATION') {
    if (meta.barrier) reject(423, 'MUTATION_BARRIER_ACTIVE');
    attempt.state = 'PRE_MUTATION_ABORTED';
    outcome = 'PRE_MUTATION_ABORTED';
  } else {
    reject(409, 'INVALID_ATTEMPT_TRANSITION');
  }
  attempt.closedReason = body.reason;
  attempt.closedAt = now;
  attempt.verifierFailedAt = now;
  await storage.put(attemptKey(attemptId), attempt);
  await storage.put(META_KEY, meta);
  return {
    status: 200,
    outcome,
    data: { attempt: publicAttempt(attempt), barrier: meta.barrier },
  };
}

async function createDispatchHold(storage, body, now) {
  assertAllowedKeys(body, [
    'version',
    'recoveryAttemptId',
    'headSha',
    'sourceHeadSha',
    'sourceRunId',
    'sourceRunAttempt',
  ]);
  const recoveryAttemptId = requireIdentifier(
    body.recoveryAttemptId,
    'INVALID_RECOVERY_ATTEMPT_ID',
  );
  const headSha = requireHeadSha(body.headSha);
  const sourceHeadSha = requireHeadSha(body.sourceHeadSha);
  const sourceRunId = requireIdentifier(body.sourceRunId, 'INVALID_SOURCE_RUN_ID', 24);
  if (!Number.isInteger(body.sourceRunAttempt)
    || body.sourceRunAttempt < 1
    || body.sourceRunAttempt > 1_000) {
    reject(400, 'INVALID_SOURCE_RUN_ATTEMPT');
  }
  const meta = await getMeta(storage);
  if (meta.barrier) reject(423, 'MUTATION_BARRIER_ACTIVE');
  const latestAttempt = await getAttempt(storage, meta.latestAttemptId);
  if (latestAttempt?.state === 'PREPARED' && latestAttempt.resultKind === 'NO_MUTATION') {
    reject(409, 'VERIFICATION_PENDING');
  }
  if (meta.currentLease?.expiresAt > now) reject(409, 'LEASE_HELD');
  if (meta.activeDispatchHoldIds.length > 0) reject(409, 'DISPATCH_HOLD_ACTIVE');
  if (meta.activeDispatchHoldIds.length >= MAX_ACTIVE_DISPATCH_HOLDS) {
    reject(503, 'STATE_UNAVAILABLE');
  }
  if (await storage.get(dispatchHoldKey(recoveryAttemptId)) !== undefined) {
    reject(409, 'DISPATCH_HOLD_ID_REUSED');
  }
  const hold = {
    version: 1,
    recoveryAttemptId,
    headSha,
    state: 'DISPATCH_HELD',
    createdAt: now,
    sourceHeadSha,
    sourceRunId,
    sourceRunAttempt: body.sourceRunAttempt,
    supersededRuns: [],
  };
  meta.activeDispatchHoldIds.push(recoveryAttemptId);
  await storage.put(dispatchHoldKey(recoveryAttemptId), hold);
  await storage.put(META_KEY, meta);
  return {
    status: 201,
    outcome: 'DISPATCH_HELD',
    data: { dispatchHold: publicDispatchHold(hold) },
  };
}

async function bindDispatchRun(storage, body, now) {
  assertAllowedKeys(body, [
    'version',
    'recoveryAttemptId',
    'headSha',
    'runId',
    'runAttempt',
  ]);
  const recoveryAttemptId = requireIdentifier(
    body.recoveryAttemptId,
    'INVALID_RECOVERY_ATTEMPT_ID',
  );
  const headSha = requireHeadSha(body.headSha);
  const runId = requireIdentifier(body.runId, 'INVALID_RUN_ID', 24);
  if (!Number.isInteger(body.runAttempt) || body.runAttempt < 1 || body.runAttempt > 1_000) {
    reject(400, 'INVALID_RUN_ATTEMPT');
  }
  const meta = await getMeta(storage);
  const hold = await getDispatchHold(storage, recoveryAttemptId);
  if (!meta.activeDispatchHoldIds.includes(recoveryAttemptId)) {
    reject(409, 'INVALID_DISPATCH_HOLD_TRANSITION');
  }
  if (hold.headSha !== headSha) reject(409, 'HEAD_SHA_MISMATCH');
  if (hold.state !== 'DISPATCH_HELD') reject(409, 'INVALID_DISPATCH_HOLD_TRANSITION');
  hold.state = 'RUN_BOUND';
  hold.runId = runId;
  hold.runAttempt = body.runAttempt;
  hold.boundAt = now;
  await storage.put(dispatchHoldKey(recoveryAttemptId), hold);
  return {
    status: 200,
    outcome: 'DISPATCH_RUN_BOUND',
    data: { dispatchHold: publicDispatchHold(hold) },
  };
}

async function rejectDispatch(storage, body, now) {
  assertAllowedKeys(body, [
    'version',
    'recoveryAttemptId',
    'headSha',
    'reason',
    'evidenceDigest',
    'sourceRunId',
    'sourceRunAttempt',
  ]);
  const recoveryAttemptId = requireIdentifier(
    body.recoveryAttemptId,
    'INVALID_RECOVERY_ATTEMPT_ID',
  );
  const headSha = requireHeadSha(body.headSha);
  const evidenceDigest = requireDigest(body.evidenceDigest, 'INVALID_EVIDENCE_DIGEST');
  const preDispatchAbort = body.reason === 'PRE_DISPATCH_NOT_STARTED';
  if (!preDispatchAbort && body.reason !== 'DISPATCH_CONFIRMED_REJECTED') {
    reject(400, 'INVALID_DISPATCH_REJECTION_REASON');
  }
  let sourceRunId = null;
  if (preDispatchAbort) {
    sourceRunId = requireIdentifier(body.sourceRunId, 'INVALID_SOURCE_RUN_ID', 24);
    if (!Number.isInteger(body.sourceRunAttempt)
      || body.sourceRunAttempt < 1
      || body.sourceRunAttempt > 1_000) {
      reject(400, 'INVALID_SOURCE_RUN_ATTEMPT');
    }
  } else if (body.sourceRunId !== undefined || body.sourceRunAttempt !== undefined) {
    reject(400, 'UNSUPPORTED_FIELD');
  }
  const meta = await getMeta(storage);
  const hold = await getDispatchHold(storage, recoveryAttemptId);
  if (!meta.activeDispatchHoldIds.includes(recoveryAttemptId)) {
    reject(409, 'INVALID_DISPATCH_HOLD_TRANSITION');
  }
  if (hold.headSha !== headSha) reject(409, 'HEAD_SHA_MISMATCH');
  if (hold.state !== 'DISPATCH_HELD') reject(409, 'INVALID_DISPATCH_HOLD_TRANSITION');
  if (preDispatchAbort && (
    hold.sourceRunId !== sourceRunId
    || hold.sourceRunAttempt !== body.sourceRunAttempt
  )) {
    reject(409, 'SOURCE_RUN_MISMATCH');
  }
  hold.state = preDispatchAbort ? 'PRE_DISPATCH_ABORTED' : 'DISPATCH_REJECTED';
  hold.reason = body.reason;
  hold.evidenceDigest = evidenceDigest;
  hold.closedAt = now;
  meta.activeDispatchHoldIds = meta.activeDispatchHoldIds.filter(
    (id) => id !== recoveryAttemptId,
  );
  await storage.put(dispatchHoldKey(recoveryAttemptId), hold);
  await storage.put(META_KEY, meta);
  return {
    status: 200,
    outcome: preDispatchAbort ? 'PRE_DISPATCH_ABORTED' : 'DISPATCH_REJECTED',
    data: { dispatchHold: publicDispatchHold(hold) },
  };
}

function requireOperatorReason(value) {
  if (
    typeof value !== 'string'
    || value.length < 10
    || value.length > 240
    || /[\u0000-\u001f\u007f]/.test(value)
    || /[`<>\[\]]/.test(value)
    || /(?:https?:\/\/|www\.)/i.test(value)
    || /(?:gh[pousr]_|github_pat_|sk-[A-Za-z0-9]|bearer\s+|-----BEGIN|(?:secret|token|api[_ -]?key)\s*[:=])/i.test(value)
  ) {
    reject(400, 'INVALID_OPERATOR_REASON');
  }
  return value;
}

function isStoredOperatorResult(result, binding) {
  const data = result?.data;
  const expectedKeys = [
    'decision',
    'evidenceDigest',
    'evidenceId',
    'headSha',
    'operationId',
    'priorGeneration',
    'priorId',
    'resolutionId',
    'supersedingAttemptId',
    'supersedingGeneration',
  ];
  return result?.status === 200
    && result.outcome === 'OPERATOR_RESOLUTION_RECORDED'
    && data
    && typeof data === 'object'
    && !Array.isArray(data)
    && JSON.stringify(Object.keys(data).sort()) === JSON.stringify(expectedKeys)
    && typeof data.resolutionId === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(data.resolutionId)
    && data.supersedingAttemptId === data.resolutionId
    && data.operationId === binding.operationId
    && data.priorId === binding.priorId
    && Number.isSafeInteger(data.priorGeneration)
    && data.priorGeneration >= 0
    && data.supersedingGeneration === data.priorGeneration + 1
    && data.headSha === binding.expectedHead
    && typeof data.evidenceId === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(data.evidenceId)
    && typeof data.evidenceDigest === 'string'
    && /^[0-9a-f]{64}$/.test(data.evidenceDigest)
    && data.decision === binding.decision;
}

async function resolveOperator(storage, body, now, randomUuid) {
  assertAllowedKeys(body, [
    'version',
    'operationId',
    'priorId',
    'priorCreatedAt',
    'expectedHead',
    'decision',
    'actor',
    'approver',
    'reason',
    'evidenceDigest',
    'intentDigest',
    'triggeringActor',
    'operatorRunId',
    'operatorRunAttempt',
    'evidenceId',
    'runEvidenceId',
    'environmentEvidenceId',
    'gateStatusId',
    'gateUpdatedAt',
    'targetRunId',
    'targetRunAttempt',
    'targetHead',
  ]);
  const operationId = requireDigest(body.operationId, 'INVALID_OPERATION_ID');
  const priorId = requireIdentifier(body.priorId, 'INVALID_PRIOR_ID');
  const priorCreatedAt = requireMillisecondIso(
    body.priorCreatedAt,
    'INVALID_PRIOR_CREATED_AT',
  );
  const expectedHead = requireHeadSha(body.expectedHead);
  if (!OPERATOR_DECISIONS.has(body.decision)) reject(400, 'INVALID_OPERATOR_DECISION');
  const actor = requireIdentifier(body.actor, 'INVALID_ACTOR_ID');
  const approver = requireIdentifier(body.approver, 'INVALID_APPROVER_ID');
  if (actor === approver) reject(400, 'OPERATOR_APPROVER_MUST_DIFFER');
  const reason = requireOperatorReason(body.reason);
  const evidenceDigest = requireDigest(body.evidenceDigest, 'INVALID_EVIDENCE_DIGEST');
  const intentDigest = body.intentDigest === null
    ? null
    : requireDigest(body.intentDigest, 'INVALID_INTENT_DIGEST');
  if (body.decision !== 'accept_observed_convergence' && intentDigest !== null) {
    reject(400, 'INVALID_INTENT_DIGEST');
  }
  const triggeringActor = requireIdentifier(body.triggeringActor, 'INVALID_TRIGGERING_ACTOR');
  const operatorRunId = requireIdentifier(body.operatorRunId, 'INVALID_OPERATOR_RUN_ID', 24);
  if (!Number.isInteger(body.operatorRunAttempt) || body.operatorRunAttempt < 1
    || body.operatorRunAttempt > 1_000) reject(400, 'INVALID_OPERATOR_RUN_ATTEMPT');
  const evidenceId = requireIdentifier(body.evidenceId, 'INVALID_EVIDENCE_ID');
  const runEvidenceId = requireIdentifier(body.runEvidenceId, 'INVALID_RUN_EVIDENCE_ID');
  const environmentEvidenceId = requireIdentifier(
    body.environmentEvidenceId,
    'INVALID_ENVIRONMENT_EVIDENCE_ID',
  );
  const gateStatusId = requireIdentifier(body.gateStatusId, 'INVALID_GATE_STATUS_ID', 24);
  if (typeof body.gateUpdatedAt !== 'string' || !Number.isFinite(Date.parse(body.gateUpdatedAt))) {
    reject(400, 'INVALID_GATE_UPDATED_AT');
  }
  const targetRunId = body.targetRunId === null
    ? null
    : requireIdentifier(body.targetRunId, 'INVALID_TARGET_RUN_ID', 24);
  const targetHead = body.targetHead === null ? null : requireHeadSha(body.targetHead);
  if ((targetRunId === null) !== (body.targetRunAttempt === null)) {
    reject(400, 'INVALID_TARGET_RUN_EVIDENCE');
  }
  if ((targetRunId === null) !== (targetHead === null)) {
    reject(400, 'INVALID_TARGET_RUN_EVIDENCE');
  }
  if (targetRunId !== null
    && (!Number.isInteger(body.targetRunAttempt) || body.targetRunAttempt < 1
      || body.targetRunAttempt > 1_000)) {
    reject(400, 'INVALID_TARGET_RUN_ATTEMPT');
  }
  const replayBinding = {
    operationId,
    priorId,
    priorCreatedAt: priorCreatedAt.value,
    expectedHead,
    decision: body.decision,
    actor,
    approver,
    reason,
    intentDigest,
    targetRunId,
    targetRunAttempt: body.targetRunAttempt,
    targetHead,
  };
  const replay = await storage.get(operatorResolutionKey(operationId));
  if (replay !== undefined) {
    const bindingKeys = Object.keys(replayBinding).sort();
    if (
      !replay
      || replay.version !== 1
      || replay.operationId !== operationId
      || !replay.binding
      || typeof replay.binding !== 'object'
      || Array.isArray(replay.binding)
      || JSON.stringify(Object.keys(replay.binding).sort()) !== JSON.stringify(bindingKeys)
      || !isStoredOperatorResult(replay.result, replay.binding)
    ) {
      reject(503, 'STATE_UNAVAILABLE');
    }
    if (JSON.stringify(replay.binding) !== JSON.stringify(replayBinding)) {
      reject(409, 'OPERATOR_OPERATION_REUSED');
    }
    return replay.result;
  }
  const meta = await getMeta(storage);
  let priorAttempt = null;
  let resolvedDispatchHold = null;
  let supersedesAttemptId = null;
  let supersedesDispatchHoldId = null;
  let priorSupersededRuns = [];

  if (body.decision === 'resolve_pre_mutation_hold') {
    const hold = await storage.get(dispatchHoldKey(priorId));
    if (hold && meta.activeDispatchHoldIds.includes(priorId)) {
      if (hold.createdAt !== priorCreatedAt.milliseconds) {
        reject(409, 'PRIOR_CREATED_AT_MISMATCH');
      }
      if (!['DISPATCH_HELD', 'RUN_BOUND'].includes(hold.state)) {
        reject(409, 'INVALID_DISPATCH_HOLD_TRANSITION');
      }
      if (meta.barrier) reject(423, 'MUTATION_BARRIER_ACTIVE');
      if (meta.currentLease?.expiresAt > now) reject(409, 'LEASE_STILL_ACTIVE');
      if (meta.currentLease) meta.currentLease = null;
      resolvedDispatchHold = hold;
      supersedesDispatchHoldId = priorId;
      priorSupersededRuns = readSupersededRuns(hold.supersededRuns);
      if ((hold.runId ?? null) !== targetRunId
        || (hold.runAttempt ?? null) !== body.targetRunAttempt) {
        reject(409, 'TARGET_RUN_MISMATCH');
      }
    } else {
      priorAttempt = await getAttempt(storage, priorId);
      if (priorAttempt.createdAt !== priorCreatedAt.milliseconds) {
        reject(409, 'PRIOR_CREATED_AT_MISMATCH');
      }
      if (meta.latestAttemptId !== priorId || priorAttempt.generation !== meta.generation) {
        reject(409, 'ATTEMPT_SUPERSEDED');
      }
      if (!['LEASED', 'PREPARED'].includes(priorAttempt.state)) {
        reject(409, 'INVALID_ATTEMPT_TRANSITION');
      }
      if (meta.barrier) reject(423, 'MUTATION_BARRIER_ACTIVE');
      if (meta.currentLease?.expiresAt > now) reject(409, 'LEASE_STILL_ACTIVE');
      if (meta.currentLease) meta.currentLease = null;
      supersedesAttemptId = priorId;
      priorSupersededRuns = readSupersededRuns(priorAttempt.supersededRuns);
      if (priorAttempt.runId !== targetRunId
        || priorAttempt.runAttempt !== body.targetRunAttempt) {
        reject(409, 'TARGET_RUN_MISMATCH');
      }
    }
  } else {
    priorAttempt = await getAttempt(storage, priorId);
    if (priorAttempt.createdAt !== priorCreatedAt.milliseconds) {
      reject(409, 'PRIOR_CREATED_AT_MISMATCH');
    }
    if (meta.latestAttemptId !== priorId || priorAttempt.generation !== meta.generation) {
      reject(409, 'ATTEMPT_SUPERSEDED');
    }
    if (!['MUTATION_STARTED', 'MANUAL_REQUIRED'].includes(priorAttempt.state)) {
      reject(409, 'INVALID_ATTEMPT_TRANSITION');
    }
    priorSupersededRuns = readSupersededRuns(priorAttempt.supersededRuns);
    if (priorAttempt.runId !== targetRunId
      || priorAttempt.runAttempt !== body.targetRunAttempt) {
      reject(409, 'TARGET_RUN_MISMATCH');
    }
    if (
      body.decision === 'accept_observed_convergence'
      && priorAttempt.headSha !== targetHead
    ) {
      reject(409, 'HEAD_SHA_MISMATCH');
    }
    if (body.decision === 'accept_observed_convergence') {
      if (intentDigest === null || priorAttempt.intentDigest !== intentDigest) {
        reject(409, 'INTENT_DIGEST_MISMATCH');
      }
    }
    if (
      meta.barrier?.attemptId !== priorId
      || meta.barrier.generation !== priorAttempt.generation
      || meta.barrier.headSha !== priorAttempt.headSha
    ) {
      reject(409, 'BARRIER_MISMATCH');
    }
    if (meta.currentLease?.expiresAt > now) reject(409, 'LEASE_STILL_ACTIVE');
    if (meta.currentLease) meta.currentLease = null;
    supersedesAttemptId = priorId;
  }

  const attemptId = randomIdentifier(randomUuid);
  const priorGeneration = priorAttempt?.generation ?? meta.generation;
  // A positive convergence decision closes the uncertainty lineage. The prior
  // attempts retain their immutable linked audit history, while the terminal
  // record needs only the exact run whose convergence was observed. This is
  // also the protected reset route when a real mutation lineage reaches the
  // bounded 64-run carry-forward limit.
  const supersededRuns = body.decision === 'accept_observed_convergence'
    ? [{ runId: targetRunId, runAttempt: body.targetRunAttempt }]
    : appendSupersededRun(priorSupersededRuns, targetRunId, body.targetRunAttempt);
  const resolutionHead = body.decision === 'accept_observed_convergence'
    ? targetHead
    : expectedHead;
  const resolution = {
    version: 1,
    attemptId,
    generation: meta.generation + 1,
    headSha: resolutionHead,
    authorizationHeadSha: expectedHead,
    ownerId: 'protected-operator',
    state: 'OPERATOR_RESOLVED',
    createdAt: now,
    leaseExpiresAt: null,
    closedAt: now,
    closedReason: 'OPERATOR_RESOLUTION',
    supersedesAttemptId,
    supersedesDispatchHoldId,
    actor,
    approver,
    decision: body.decision,
    reason,
    evidenceDigest,
    triggeringActor,
    operatorRunId,
    operatorRunAttempt: body.operatorRunAttempt,
    evidenceId,
    runEvidenceId,
    environmentEvidenceId,
    gateStatusId,
    gateUpdatedAt: body.gateUpdatedAt,
    priorCreatedAt: priorCreatedAt.value,
    supersededRuns,
  };
  let recoveryDispatchHold = null;
  if (body.decision === 'accept_observed_convergence') {
    resolution.state = 'TERMINAL_ACCEPTED';
    resolution.intentDigest = intentDigest;
    resolution.resultKind = 'OPERATOR_OBSERVED_CONVERGENCE';
    resolution.resultDigest = evidenceDigest;
    resolution.acceptedAt = now;
    resolution.closedReason = 'OPERATOR_ACCEPTED_OBSERVED_CONVERGENCE';
    meta.lastAccepted = {
      version: 1,
      attemptId,
      generation: resolution.generation,
      headSha: resolutionHead,
      intentDigest: resolution.intentDigest,
      resultDigest: evidenceDigest,
      resultKind: resolution.resultKind,
      acceptedAt: now,
      runId: targetRunId,
      runAttempt: body.targetRunAttempt,
      supersededRuns,
    };
  } else if (body.decision === 'authorize_current_main_retry') {
    if (meta.activeDispatchHoldIds.length > 0) reject(409, 'DISPATCH_HOLD_ACTIVE');
    recoveryDispatchHold = {
      version: 1,
      recoveryAttemptId: attemptId,
      headSha: expectedHead,
      state: 'DISPATCH_HELD',
      createdAt: now,
      sourceHeadSha: expectedHead,
      sourceRunId: operatorRunId,
      sourceRunAttempt: body.operatorRunAttempt,
      supersededRuns,
    };
    meta.activeDispatchHoldIds.push(attemptId);
  }
  if (resolvedDispatchHold) {
    resolvedDispatchHold.state = 'OPERATOR_RESOLVED';
    resolvedDispatchHold.closedAt = now;
    resolvedDispatchHold.operatorResolutionId = attemptId;
    meta.activeDispatchHoldIds = meta.activeDispatchHoldIds.filter((id) => id !== priorId);
    await storage.put(dispatchHoldKey(priorId), resolvedDispatchHold);
  }
  meta.generation = resolution.generation;
  meta.latestAttemptId = attemptId;
  if (body.decision !== 'resolve_pre_mutation_hold') meta.barrier = null;
  await storage.put(attemptKey(attemptId), resolution);
  if (recoveryDispatchHold) {
    await storage.put(dispatchHoldKey(attemptId), recoveryDispatchHold);
  }
  await storage.put(META_KEY, meta);
  const result = {
    status: 200,
    outcome: 'OPERATOR_RESOLUTION_RECORDED',
    data: {
      resolutionId: attemptId,
      operationId,
      priorId,
      priorGeneration,
      supersedingGeneration: resolution.generation,
      supersedingAttemptId: attemptId,
      headSha: expectedHead,
      evidenceId,
      evidenceDigest,
      decision: body.decision,
    },
  };
  await storage.put(operatorResolutionKey(operationId), {
    version: 1,
    operationId,
    binding: replayBinding,
    result,
  });
  return result;
}

async function status(storage, body, now) {
  assertAllowedKeys(body, []);
  const meta = await getMeta(storage);
  const currentAttempt = await getAttempt(storage, meta.latestAttemptId);
  const dispatchHolds = [];
  for (const recoveryAttemptId of meta.activeDispatchHoldIds) {
    dispatchHolds.push(publicDispatchHold(await getDispatchHold(storage, recoveryAttemptId)));
  }
  return {
    status: 200,
    outcome: 'STATUS_REPORTED',
    data: {
      generation: meta.generation,
      lease: publicLease(meta.currentLease, now),
      currentAttempt: publicAttempt(currentAttempt),
      barrier: meta.barrier,
      lastAccepted: meta.lastAccepted,
      dispatchHolds,
    },
  };
}

async function dispatchAction(action, storage, body, context) {
  if (action === 'acquire') {
    return acquire(storage, body, context.now, context.randomBytes, context.randomUuid);
  }
  if (action === 'prepare') return prepare(storage, body, context.now);
  if (action === 'assertOwner') return assertOwner(storage, body, context.now);
  if (action === 'start') return startMutation(storage, body, context.now);
  if (action === 'bindResult') return bindResult(storage, body, context.now);
  if (action === 'release') return release(storage, body, context.now);
  if (action === 'abort') return abortPreMutation(storage, body, context.now);
  if (action === 'accept') return accept(storage, body, context.now, context.operationDigest);
  if (action === 'failVerification') return failVerification(storage, body, context.now);
  if (action === 'status') return status(storage, body, context.now);
  if (action === 'dispatchHold') return createDispatchHold(storage, body, context.now);
  if (action === 'bindRun') return bindDispatchRun(storage, body, context.now);
  if (action === 'dispatchRejected') return rejectDispatch(storage, body, context.now);
  if (action === 'operatorResolve') {
    return resolveOperator(
      storage,
      body,
      context.now,
      context.randomUuid,
    );
  }
  reject(501, 'NOT_IMPLEMENTED');
}

export class RailwayReconcileControl {
  constructor(state, env, options = {}) {
    this.storage = state?.storage;
    this.env = env || {};
    this.now = options.now || (() => Date.now());
    this.randomBytes = options.randomBytes || ((length) => crypto.getRandomValues(new Uint8Array(length)));
    this.randomUuid = options.randomUuid || (() => crypto.randomUUID());
  }

  async fetch(request) {
    try {
      if (!this.storage?.transaction) reject(503, 'STATE_UNAVAILABLE');
      const url = new URL(request.url);
      if (url.search || url.hash) reject(400, 'UNSUPPORTED_URL');
      const route = ROUTES[url.pathname];
      if (!route) {
        const code = /^\/v\d+\//.test(url.pathname)
          ? 'UNKNOWN_PROTOCOL_VERSION'
          : 'ROUTE_NOT_FOUND';
        reject(404, code);
      }
      const isStatusRead = route.action === 'status';
      if ((isStatusRead && request.method !== 'GET') || (!isStatusRead && request.method !== 'POST')) {
        reject(405, 'METHOD_NOT_ALLOWED');
      }
      if (!isStatusRead && !request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
        reject(415, 'CONTENT_TYPE_REQUIRED');
      }
      const contentLength = Number(request.headers.get('content-length') || 0);
      if (contentLength > MAX_REQUEST_BODY_BYTES) reject(413, 'REQUEST_TOO_LARGE');
      const bodyBytes = await readBoundedRequestBody(request);
      if (isStatusRead && bodyBytes.byteLength !== 0) reject(400, 'UNSUPPORTED_FIELD');

      const roleHeader = request.headers.get('x-wm-control-role') || '';
      const versionHeader = request.headers.get('x-wm-control-version') || '';
      const timestampText = request.headers.get('x-wm-control-timestamp') || '';
      const nonce = request.headers.get('x-wm-control-nonce') || '';
      const signatureHeader = request.headers.get('x-wm-control-signature') || '';
      if (versionHeader !== '1') reject(400, 'UNKNOWN_PROTOCOL_VERSION');
      if (roleHeader !== route.role) reject(403, 'AUTH_ROLE_FORBIDDEN');
      if (!/^\d{1,12}$/.test(timestampText)) reject(401, 'AUTH_INVALID');
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) reject(401, 'AUTH_INVALID');
      if (!/^[0-9a-f]{64}$/.test(signatureHeader)) reject(401, 'AUTH_INVALID');
      const timestamp = Number(timestampText);
      const now = this.now();
      if (
        !Number.isSafeInteger(timestamp)
        || timestamp <= 0
        || Math.abs(Math.floor(now / 1000) - timestamp) > AUTH_CLOCK_WINDOW_MS / 1000
      ) {
        reject(401, 'AUTH_STALE');
      }
      const secret = requireIndependentRoleSecrets(this.env)[route.role];
      const bodyDigest = await sha256Hex(bodyBytes);
      const canonical = `${request.method}\n${url.pathname}\n${bodyDigest}\n${timestampText}\n${nonce}`;
      if (!await verifyHmac(secret, canonical, signatureHeader)) {
        reject(401, 'AUTH_INVALID');
      }

      const nonceHash = await sha256Hex(`${route.role}\n${nonce}`);
      await this.storage.transaction(async (storage) => {
        await consumeNonce(
          storage,
          route.role,
          nonceHash,
          (timestamp * 1000) + AUTH_CLOCK_WINDOW_MS + AUTH_TIMESTAMP_GRANULARITY_MS,
          now,
        );
      });

      let body = {};
      if (!isStatusRead) {
        try {
          body = JSON.parse(textDecoder.decode(bodyBytes));
        } catch {
          reject(400, 'MALFORMED_JSON');
        }
        assertObject(body);
        if (body.version !== 1) reject(400, 'UNKNOWN_PROTOCOL_VERSION');
      }
      const result = await this.storage.transaction(async (storage) => (
        dispatchAction(route.action, storage, body, {
          now,
          randomBytes: this.randomBytes,
          randomUuid: this.randomUuid,
          operationDigest: bodyDigest,
        })
      ));
      return successResponse(result.status, result.outcome, result.data);
    } catch (error) {
      if (error instanceof ControlError) return errorResponse(error.status, error.code);
      return errorResponse(503, 'STATE_UNAVAILABLE');
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/version') {
      if (request.method !== 'GET' || url.search || url.hash) {
        return errorResponse(405, 'METHOD_NOT_ALLOWED');
      }
      const deploymentSha = env?.DEPLOYMENT_SHA;
      if (typeof deploymentSha !== 'string' || !/^[0-9a-f]{7,64}$/.test(deploymentSha)) {
        return errorResponse(503, 'CONTROL_PLANE_UNAVAILABLE');
      }
      return jsonResponse(200, { protocolVersion: 1, deploymentSha });
    }
    const scope = env?.CONTROL_SCOPE;
    const namespace = env?.RAILWAY_RECONCILE_CONTROL;
    if (
      typeof scope !== 'string'
      || scope.length < 1
      || scope.length > 200
      || /[\u0000-\u001f\u007f]/.test(scope)
      || !namespace?.idFromName
      || !namespace?.get
    ) {
      return errorResponse(503, 'CONTROL_PLANE_UNAVAILABLE');
    }

    const id = namespace.idFromName(scope);
    return namespace.get(id).fetch(request);
  },
};
