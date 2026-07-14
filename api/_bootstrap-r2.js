import { AwsClient } from 'aws4fetch';

const MINUTE_MS = 60_000;
const MAX_FUTURE_SKEW_MS = 5 * MINUTE_MS;
const MAX_AGE_MS = Object.freeze({
  fast: 15 * MINUTE_MS,
  slow: 60 * MINUTE_MS,
});

// U3a replaces these placeholders with independently measured per-tier values.
// Keeping them unusable prevents an assumed budget from silently becoming the
// production serving contract before the shadow measurement has completed.
export const BOOTSTRAP_R2_TIMEOUT_MS_FAST = null;
export const BOOTSTRAP_R2_TIMEOUT_MS_SLOW = null;
export const BOOTSTRAP_R2_PROBE_CEILING_MS = 5_000;
export const BOOTSTRAP_R2_HEALTH_TIMEOUT_MS = 2_000;

export function bootstrapR2ServingTimeoutMs(tier) {
  const timeoutMs = tier === 'fast'
    ? BOOTSTRAP_R2_TIMEOUT_MS_FAST
    : tier === 'slow'
      ? BOOTSTRAP_R2_TIMEOUT_MS_SLOW
      : null;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`U3a has not calibrated the ${tier} bootstrap R2 serving timeout`);
  }
  return timeoutMs;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isValidEnvelope(envelope, tier, nowMs) {
  return isPlainObject(envelope)
    && envelope.tier === tier
    && Number.isFinite(envelope.generatedAt)
    && Number.isInteger(envelope.generatedAt)
    && envelope.generatedAt <= nowMs + MAX_FUTURE_SKEW_MS
    && isPlainObject(envelope.payload)
    && isPlainObject(envelope.payload.data)
    && Array.isArray(envelope.payload.missing);
}

function readConfig(env) {
  const accountId = env.R2_ACCOUNT_ID;
  const endpoint = env.R2_ENDPOINT
    || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '');
  const bucket = env.R2_BOOTSTRAP_BUCKET;
  const accessKeyId = env.R2_BOOTSTRAP_READ_KEY_ID;
  const secretAccessKey = env.R2_BOOTSTRAP_READ_SECRET;

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint: endpoint.replace(/\/+$/, ''),
    bucket,
    accessKeyId,
    secretAccessKey,
  };
}

function fallback(reason, startedAt) {
  return {
    status: 'fallback',
    reason,
    durationMs: Math.max(0, performance.now() - startedAt),
  };
}

/**
 * Read and validate one preassembled public bootstrap tier from private R2.
 * Every failure is converted to a discriminated fallback result so R2 can
 * never throw into the bootstrap request path.
 */
export async function readBootstrapTierObject(tier, options = {}) {
  const startedAt = performance.now();
  const {
    timeoutMs,
    nowMs = Date.now(),
    env = process.env,
    awsClientFactory = config => new AwsClient(config),
  } = options;

  if (!Object.hasOwn(MAX_AGE_MS, tier)) return fallback('invalid', startedAt);

  const config = readConfig(env);
  if (!config) return fallback('unreadable', startedAt);

  let signal;
  let response;
  try {
    signal = AbortSignal.timeout(timeoutMs);
    const client = awsClientFactory({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: 's3',
      region: 'auto',
      retries: 0,
    });
    response = await client.fetch(
      `${config.endpoint}/${encodeURIComponent(config.bucket)}/${tier}.json`,
      {
        method: 'GET',
        headers: { 'User-Agent': 'WorldMonitor Bootstrap/1.0' },
        signal,
      },
    );
  } catch (error) {
    const timedOut = signal?.aborted
      || error?.name === 'TimeoutError'
      || error?.name === 'AbortError';
    return fallback(timedOut ? 'timeout' : 'unreadable', startedAt);
  }

  if (response.status === 404) return fallback('missing', startedAt);
  if (!response.ok) return fallback('unreadable', startedAt);

  let envelope;
  try {
    envelope = await response.json();
  } catch (error) {
    const timedOut = signal?.aborted
      || error?.name === 'TimeoutError'
      || error?.name === 'AbortError';
    return fallback(timedOut ? 'timeout' : 'invalid', startedAt);
  }

  if (!isValidEnvelope(envelope, tier, nowMs)) {
    return fallback('invalid', startedAt);
  }
  if (nowMs - envelope.generatedAt > MAX_AGE_MS[tier]) {
    return fallback('stale', startedAt);
  }

  return {
    status: 'ok',
    payload: envelope.payload,
    generatedAt: envelope.generatedAt,
    durationMs: Math.max(0, performance.now() - startedAt),
  };
}
