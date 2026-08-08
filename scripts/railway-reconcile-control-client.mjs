import { createHash, createHmac, randomUUID } from 'node:crypto';

export const CONTROL_PROTOCOL_VERSION = 1;
export const CONTROL_CLIENT_USER_AGENT = 'worldmonitor-railway-reconcile-control/1';
const CONTROL_HOST_LABEL = 'railway-reconcile-control';
const FIRST_PARTY_ROOT_HOST = 'worldmonitor.app';
export const CONTROL_ORIGIN = `https://${CONTROL_HOST_LABEL}.${FIRST_PARTY_ROOT_HOST}`;

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 15_000;
const MIN_SECRET_BYTES = 32;
const MAX_SECRET_BYTES = 1024;
const ROLE_ROUTES = Object.freeze({
  mutation: new Set([
    '/v1/mutation/acquire',
    '/v1/mutation/prepare',
    '/v1/mutation/assert',
    '/v1/mutation/start',
    '/v1/mutation/bind-result',
    '/v1/mutation/release',
    '/v1/mutation/abort',
  ]),
  verifier: new Set([
    '/v1/verifier/accept',
    '/v1/verifier/fail',
  ]),
  watchdog: new Set([
    '/v1/watchdog/status',
    '/v1/watchdog/dispatch-hold',
    '/v1/watchdog/bind-run',
    '/v1/watchdog/dispatch-rejected',
  ]),
  operator: new Set([
    '/v1/operator/resolve',
  ]),
});

const SUCCESS_CONTRACTS = Object.freeze({
  '/v1/mutation/acquire': [['LEASE_GRANTED'], [
    'attempt', 'leaseCapability', 'leaseExpiresAt', 'supersededAttempt', 'dispatchHold',
  ]],
  '/v1/mutation/prepare': [['ATTEMPT_PREPARED'], ['attempt']],
  '/v1/mutation/assert': [['LEASE_ASSERTED'], ['attempt', 'remainingTtlMs']],
  '/v1/mutation/start': [['MUTATION_STARTED'], ['attempt', 'barrier', 'remainingTtlMs']],
  '/v1/mutation/bind-result': [['RESULT_BOUND'], ['attempt']],
  '/v1/mutation/release': [['LEASE_RELEASED'], ['attempt']],
  '/v1/mutation/abort': [['PRE_MUTATION_ABORTED'], ['attempt']],
  '/v1/verifier/accept': [['TERMINAL_ACCEPTED'], ['attempt', 'barrier', 'lastAccepted']],
  '/v1/verifier/fail': [['MANUAL_REQUIRED', 'PRE_MUTATION_ABORTED'], ['attempt', 'barrier']],
  '/v1/watchdog/status': [['STATUS_REPORTED'], [
    'generation', 'lease', 'currentAttempt', 'barrier', 'lastAccepted', 'dispatchHolds',
  ]],
  '/v1/watchdog/dispatch-hold': [['DISPATCH_HELD'], ['dispatchHold']],
  '/v1/watchdog/bind-run': [['DISPATCH_RUN_BOUND'], ['dispatchHold']],
  '/v1/watchdog/dispatch-rejected': [[
    'DISPATCH_REJECTED',
    'PRE_DISPATCH_ABORTED',
  ], ['dispatchHold']],
  '/v1/operator/resolve': [['OPERATOR_RESOLUTION_RECORDED'], [
    'resolutionId', 'operationId', 'priorId', 'priorGeneration',
    'supersedingGeneration', 'supersedingAttemptId', 'headSha', 'evidenceId',
    'evidenceDigest', 'decision',
  ]],
});

function canonicalValue(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON rejects non-finite numbers');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== 'object') {
    throw new TypeError(`canonical JSON rejects ${typeof value}`);
  }
  const result = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    if (key === '__proto__') throw new TypeError('canonical JSON rejects __proto__ keys');
    if (value[key] === undefined) throw new TypeError('canonical JSON rejects undefined');
    result[key] = canonicalValue(value[key]);
  }
  return result;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function validOutcome(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value);
}

function validateEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ControlPlaneError('CONTROL_SCHEMA_INVALID', 'control plane response is not an object');
  }
  if (value.version !== CONTROL_PROTOCOL_VERSION) {
    throw new ControlPlaneError('CONTROL_VERSION_UNSUPPORTED', 'control plane response version is unsupported');
  }
  if (typeof value.ok !== 'boolean' || !validOutcome(value.outcome)) {
    throw new ControlPlaneError('CONTROL_SCHEMA_INVALID', 'control plane response has an invalid outcome envelope');
  }
  if (value.ok) {
    if (!exactKeys(value, ['version', 'ok', 'outcome', 'data'])
      || !value.data || typeof value.data !== 'object' || Array.isArray(value.data)) {
      throw new ControlPlaneError('CONTROL_SCHEMA_INVALID', 'control plane success response violates the closed schema');
    }
    return value;
  }
  if (!exactKeys(value, ['version', 'ok', 'outcome', 'error'])
    || !exactKeys(value.error, ['code', 'message'])
    || !validOutcome(value.error.code)
    || typeof value.error.message !== 'string'
    || value.error.message.length < 1
    || value.error.message.length > 240
    || /[\u0000-\u001f\u007f]/.test(value.error.message)) {
    throw new ControlPlaneError('CONTROL_SCHEMA_INVALID', 'control plane error response violates the closed schema');
  }
  if (value.outcome !== value.error.code) {
    throw new ControlPlaneError('CONTROL_SCHEMA_INVALID', 'control plane error outcome must equal its code');
  }
  return value;
}

function validateRouteSuccess(path, envelope) {
  const contract = SUCCESS_CONTRACTS[path];
  if (!contract) throw new ControlPlaneError('CONTROL_ROUTE_FORBIDDEN', 'control route has no response contract');
  const [outcomes, dataKeys] = contract;
  if (!outcomes.includes(envelope.outcome) || !exactKeys(envelope.data, dataKeys)) {
    throw new ControlPlaneError(
      'CONTROL_SCHEMA_INVALID',
      `control plane response violates the closed contract for ${path}`,
    );
  }
  return envelope;
}

export class ControlPlaneError extends Error {
  constructor(code, message, {
    outcome = code,
    status = null,
    cause = undefined,
    definitive = false,
  } = {}) {
    super(message, { cause });
    this.name = 'ControlPlaneError';
    this.code = code;
    this.outcome = outcome;
    this.status = status;
    this.definitive = definitive;
  }
}

function ambiguousPostError(error, ambiguous) {
  if (!ambiguous) return error;
  if (error instanceof ControlPlaneError) {
    if (error.definitive || error.code.endsWith('_AMBIGUOUS')) return error;
    return new ControlPlaneError(`${error.code}_AMBIGUOUS`, error.message, {
      outcome: error.outcome,
      status: error.status,
      cause: error,
    });
  }
  return new ControlPlaneError(
    'CONTROL_SCHEMA_INVALID_AMBIGUOUS',
    'control plane response could not be validated after a state-changing request',
    { cause: error },
  );
}

function validateBaseUrl(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch (cause) {
    throw new TypeError('RAILWAY_RECONCILE_CONTROL_URL must be a valid HTTPS origin', { cause });
  }
  if (url.protocol !== 'https:' || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('RAILWAY_RECONCILE_CONTROL_URL must be one credential-free HTTPS origin');
  }
  if (url.origin !== CONTROL_ORIGIN) {
    throw new TypeError(`RAILWAY_RECONCILE_CONTROL_URL must equal ${CONTROL_ORIGIN}`);
  }
  return url.origin;
}

function addVersion(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TypeError('control plane request body must be an object');
  }
  if (Object.hasOwn(body, 'version') && body.version !== CONTROL_PROTOCOL_VERSION) {
    throw new TypeError('control plane request uses an unsupported version');
  }
  return { ...body, version: CONTROL_PROTOCOL_VERSION };
}

export class RailwayReconcileControlClient {
  constructor({
    baseUrl = process.env.RAILWAY_RECONCILE_CONTROL_URL,
    role,
    secret,
    fetchImpl = (...args) => globalThis.fetch(...args),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    now = Date.now,
    nonce = randomUUID,
  }) {
    if (!Object.hasOwn(ROLE_ROUTES, role)) throw new TypeError(`unsupported control credential role: ${role}`);
    const secretBytes = typeof secret === 'string' ? Buffer.byteLength(secret, 'utf8') : 0;
    if (secretBytes < MIN_SECRET_BYTES || secretBytes > MAX_SECRET_BYTES) {
      throw new TypeError(`${role} control secret must contain 32 to 1024 bytes`);
    }
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new TypeError(`control timeout must be an integer from 1 to ${MAX_TIMEOUT_MS}ms`);
    }
    this.baseUrl = validateBaseUrl(baseUrl);
    this.role = role;
    this.secret = secret;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.nonce = nonce;
  }

  async request(path, body = {}, { method = 'POST' } = {}) {
    if (!ROLE_ROUTES[this.role].has(path)) {
      throw new ControlPlaneError('CONTROL_ROUTE_FORBIDDEN', `${path} is not allowed for ${this.role}`);
    }
    const isRead = this.role === 'watchdog' && path === '/v1/watchdog/status' && method === 'GET';
    const isRetryableOperatorResolution = this.role === 'operator'
      && path === '/v1/operator/resolve'
      && method === 'POST';
    const attempts = isRead || isRetryableOperatorResolution ? 2 : 1;
    const encodedBody = method === 'GET' ? '' : canonicalJson(addVersion(body));
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.#requestOnce(path, encodedBody, { method, ambiguous: !isRead });
      } catch (error) {
        lastError = error;
        const retryableRead = isRead && error instanceof ControlPlaneError
          && ['CONTROL_TRANSPORT', 'CONTROL_TIMEOUT', 'CONTROL_HTTP_RETRYABLE'].includes(error.code);
        const retryableOperatorResolution = isRetryableOperatorResolution
          && error instanceof ControlPlaneError
          && error.code.endsWith('_AMBIGUOUS');
        const retryable = attempt === 0 && (retryableRead || retryableOperatorResolution);
        if (!retryable) throw error;
      }
    }
    throw lastError;
  }

  async #requestOnce(path, encodedBody, { method, ambiguous }) {
    const timestamp = Math.floor(this.now() / 1_000);
    const nonce = this.nonce();
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new TypeError('control timestamp is invalid');
    if (typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 128) {
      throw new TypeError('control nonce must contain 16 to 128 characters');
    }
    const digest = sha256(encodedBody);
    const canonical = [method, path, digest, String(timestamp), nonce].join('\n');
    const signature = createHmac('sha256', this.secret).update(canonical).digest('hex');
    const headers = {
      accept: 'application/json',
      'user-agent': CONTROL_CLIENT_USER_AGENT,
      'x-wm-control-role': this.role,
      'x-wm-control-version': String(CONTROL_PROTOCOL_VERSION),
      'x-wm-control-timestamp': String(timestamp),
      'x-wm-control-nonce': nonce,
      'x-wm-control-signature': signature,
    };
    if (method !== 'GET') headers['content-type'] = 'application/json';
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new DOMException('control plane request timed out', 'TimeoutError')),
      this.timeoutMs,
    );
    let response;
    try {
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers,
          ...(method === 'GET' ? {} : { body: encodedBody }),
          redirect: 'error',
          signal: controller.signal,
        });
      } catch (cause) {
        const suffix = ambiguous ? '_AMBIGUOUS' : '';
        if (controller.signal.aborted) {
          throw new ControlPlaneError(`CONTROL_TIMEOUT${suffix}`, 'control plane request exceeded its timeout', { cause });
        }
        throw new ControlPlaneError(`CONTROL_TRANSPORT${suffix}`, 'control plane transport failed', { cause });
      }
      if (!(response instanceof Response)) {
        throw new ControlPlaneError('CONTROL_SCHEMA_INVALID', 'control plane transport returned no Response');
      }
      if (response.redirected) {
        throw new ControlPlaneError('CONTROL_REDIRECT_REJECTED', 'control plane redirects are forbidden');
      }
      if (isRetryableStatus(response.status)) {
        throw new ControlPlaneError('CONTROL_HTTP_RETRYABLE', `control plane returned HTTP ${response.status}`, {
          status: response.status,
        });
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (!/^application\/json(?:;|$)/i.test(contentType)) {
        throw new ControlPlaneError('CONTROL_JSON_REQUIRED', 'control plane response must be JSON', { status: response.status });
      }
      let parsed;
      try {
        parsed = JSON.parse(await response.text());
      } catch (cause) {
        const suffix = ambiguous ? '_AMBIGUOUS' : '';
        if (controller.signal.aborted) {
          throw new ControlPlaneError(`CONTROL_TIMEOUT${suffix}`, 'control plane response body exceeded its timeout', {
            status: response.status,
            cause,
          });
        }
        throw new ControlPlaneError('CONTROL_JSON_INVALID', 'control plane returned malformed JSON', {
          status: response.status,
          cause,
        });
      }
      const envelope = validateEnvelope(parsed);
      if (envelope.ok && response.ok) return validateRouteSuccess(path, envelope);
      if (!envelope.ok && !response.ok) {
        throw new ControlPlaneError(envelope.error.code, envelope.error.message, {
          outcome: envelope.outcome,
          status: response.status,
          definitive: true,
        });
      }
      throw new ControlPlaneError(
        'CONTROL_STATUS_MISMATCH',
        'control plane HTTP status and response envelope disagree',
        { status: response.status },
      );
    } catch (error) {
      throw ambiguousPostError(error, ambiguous);
    } finally {
      clearTimeout(timeout);
    }
  }

  acquire(body) { return this.request('/v1/mutation/acquire', body); }
  prepare(body) { return this.request('/v1/mutation/prepare', body); }
  assertLease(body) { return this.request('/v1/mutation/assert', body); }
  startMutation(body) { return this.request('/v1/mutation/start', body); }
  bindResult(body) { return this.request('/v1/mutation/bind-result', body); }
  release(body) { return this.request('/v1/mutation/release', body); }
  abort(body) { return this.request('/v1/mutation/abort', body); }
  accept(body) { return this.request('/v1/verifier/accept', body); }
  fail(body) { return this.request('/v1/verifier/fail', body); }
  status() { return this.request('/v1/watchdog/status', {}, { method: 'GET' }); }
  createDispatchHold(body) { return this.request('/v1/watchdog/dispatch-hold', body); }
  bindRun(body) { return this.request('/v1/watchdog/bind-run', body); }
  rejectDispatch(body) { return this.request('/v1/watchdog/dispatch-rejected', body); }
  resolve(body) { return this.request('/v1/operator/resolve', body); }
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}
