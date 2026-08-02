#!/usr/bin/env node

let _S3Client, _PutObjectCommand, _GetObjectCommand;
async function loadS3SDK() {
  if (!_S3Client) {
    const sdk = await import('@aws-sdk/client-s3');
    _S3Client = sdk.S3Client;
    _PutObjectCommand = sdk.PutObjectCommand;
    _GetObjectCommand = sdk.GetObjectCommand;
  }
  return { S3Client: _S3Client, PutObjectCommand: _PutObjectCommand, GetObjectCommand: _GetObjectCommand };
}

// ── S3-mode timeout guards (issue #4786) ─────────────────────────────────
// The Cloudflare-R2-API branches below bound every request with
// AbortSignal.timeout(30_000). The S3-SDK branches historically did NOT: a
// stalled `client.send`, or a `Body.transformToString()` whose socket is
// silently reaped by the keep-alive agent, leaves a promise that NEVER
// settles — no rejection for a try/catch to catch, and no open handle to
// keep the event loop alive. In a seeder that awaits R2 at the top level
// (e.g. seed-forecasts reading prior trace state) that drains the loop and
// Node exits 13 with "Detected unsettled top-level await" — a red Railway
// badge that is neither a graceful skip nor a catchable failure.
const R2_S3_TIMEOUT_MS = 30_000;
let _s3TimeoutMs = R2_S3_TIMEOUT_MS;   // overridable in tests
let _s3ClientOverride = null;          // test hook: inject a fake S3 client

function __setS3ClientForTests(client) { _s3ClientOverride = client; }
function __setR2S3TimeoutForTests(ms) { _s3TimeoutMs = ms == null ? R2_S3_TIMEOUT_MS : ms; }

// Guarantees the returned promise settles: rejects if `promise` has not
// settled within `ms`. clearTimeout in finally so a fast-settling call
// leaves no pending timer holding the event loop open.
function withSettleTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    // "timed out" keeps isRetryableR2Error treating a transient stall as
    // retryable, mirroring the api-mode AbortSignal.timeout failures.
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms (S3 op did not settle)`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

const R2_STORAGE_PROFILES = Object.freeze({
  default: Object.freeze({
    accountId: ['CLOUDFLARE_R2_ACCOUNT_ID'],
    endpoint: ['CLOUDFLARE_R2_ENDPOINT'],
    accessKeyId: ['CLOUDFLARE_R2_ACCESS_KEY_ID'],
    secretAccessKey: ['CLOUDFLARE_R2_SECRET_ACCESS_KEY'],
    apiToken: ['CLOUDFLARE_R2_TOKEN', 'CLOUDFLARE_API_TOKEN'],
    apiBaseUrl: ['CLOUDFLARE_API_BASE_URL'],
    region: ['CLOUDFLARE_R2_REGION'],
    forcePathStyle: ['CLOUDFLARE_R2_FORCE_PATH_STYLE'],
    defaultPrefix: 'seed-data/forecast-traces',
  }),
  bootstrap: Object.freeze({
    accountId: ['R2_ACCOUNT_ID'],
    endpoint: ['R2_ENDPOINT'],
    bucket: ['R2_BOOTSTRAP_BUCKET'],
    accessKeyId: ['R2_BOOTSTRAP_ACCESS_KEY_ID'],
    secretAccessKey: ['R2_BOOTSTRAP_SECRET_ACCESS_KEY'],
    apiToken: [],
    apiBaseUrl: [],
    region: [],
    forcePathStyle: [],
    defaultPrefix: '',
  }),
});

function getEnvValue(env, keys) {
  for (const key of keys) {
    if (env[key]) return env[key];
  }
  return '';
}

function parseBoolean(value, fallback) {
  if (value == null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeError(err) {
  return err?.message || String(err);
}

function isRetryableApiStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function isRetryableR2Error(err) {
  const status = err?.status;
  if (typeof status === 'number') return isRetryableApiStatus(status);

  const message = summarizeError(err).toLowerCase();
  if (
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('econnreset') ||
    message.includes('socket hang up') ||
    message.includes('temporarily unavailable') ||
    message.includes('internalerror') ||
    message.includes('service unavailable') ||
    message.includes('throttl')
  ) {
    return true;
  }

  const httpStatus = err?.$metadata?.httpStatusCode;
  if (typeof httpStatus === 'number') return isRetryableApiStatus(httpStatus);
  return false;
}

async function withR2Retry(operation, context = {}) {
  const maxAttempts = 3;
  const delays = [0, 500, 1500];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      const retryable = isRetryableR2Error(err);
      const lastAttempt = attempt === maxAttempts;
      if (!retryable || lastAttempt) throw err;

      console.warn(`  [R2] Retry ${attempt}/${maxAttempts - 1} for ${context.op || 'operation'} key=${context.key || ''}: ${summarizeError(err)}`);
      await sleep(delays[attempt] || 1500);
    }
  }
}

function resolveR2StorageConfig(env = process.env, options = {}) {
  const profileName = options.profile || 'default';
  const profile = R2_STORAGE_PROFILES[profileName];
  if (!profile) throw new TypeError(`Unknown R2 storage profile: ${profileName}`);

  const isDefaultProfile = profileName === 'default';
  const accountId = getEnvValue(env, profile.accountId);
  const bucketKeys = profile.bucket
    || [options.bucketEnv || 'CLOUDFLARE_R2_TRACE_BUCKET', 'CLOUDFLARE_R2_BUCKET'];
  const bucket = getEnvValue(env, bucketKeys);
  const accessKeyId = getEnvValue(env, profile.accessKeyId);
  const secretAccessKey = getEnvValue(env, profile.secretAccessKey);
  const apiToken = getEnvValue(env, profile.apiToken);
  const endpoint = getEnvValue(env, profile.endpoint) || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '');
  const apiBaseUrl = getEnvValue(env, profile.apiBaseUrl) || 'https://api.cloudflare.com/client/v4';
  const region = getEnvValue(env, profile.region) || 'auto';
  const prefixKeys = isDefaultProfile ? [options.prefixEnv || 'CLOUDFLARE_R2_TRACE_PREFIX'] : [];
  const basePrefix = (getEnvValue(env, prefixKeys) || profile.defaultPrefix)
    .replace(/^\/+|\/+$/g, '');
  const forcePathStyle = parseBoolean(getEnvValue(env, profile.forcePathStyle), true);

  if (!bucket || !accountId) {
    console.log(`  [R2] Config: accountId=${accountId ? 'set' : 'MISSING'}, bucket=${bucket ? 'set' : 'MISSING'}`);
    return null;
  }

  if (endpoint && accessKeyId && secretAccessKey) {
    return {
      mode: 's3',
      accountId,
      bucket,
      endpoint,
      region,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle,
      basePrefix,
    };
  }

  if (apiToken) {
    return {
      mode: 'api',
      accountId,
      bucket,
      apiToken,
      apiBaseUrl,
      basePrefix,
    };
  }

  return null;
}

const CLIENT_CACHE = new Map();

async function getR2StorageClient(config) {
  if (_s3ClientOverride) return _s3ClientOverride;
  const cacheKey = JSON.stringify({
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    accessKeyId: config.credentials.accessKeyId,
    forcePathStyle: config.forcePathStyle,
  });
  let client = CLIENT_CACHE.get(cacheKey);
  if (!client) {
    const { S3Client } = await loadS3SDK();
    client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: config.credentials,
      forcePathStyle: config.forcePathStyle,
      // Bound connection + socket-inactivity so a stalled R2 socket fails
      // fast (→ withR2Retry → caller fallback) rather than hanging the run.
      requestHandler: { requestTimeout: R2_S3_TIMEOUT_MS, connectionTimeout: 10_000 },
    });
    CLIENT_CACHE.set(cacheKey, client);
  }
  return client;
}

async function putR2JsonObject(config, key, payload, metadata = {}) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;

  if (config.mode === 'api') {
    return withR2Retry(async () => {
      const encodedKey = key.split('/').map(part => encodeURIComponent(part)).join('/');
      const resp = await fetch(`${config.apiBaseUrl}/accounts/${config.accountId}/r2/buckets/${config.bucket}/objects/${encodedKey}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        const error = new Error(`Cloudflare R2 API upload failed: HTTP ${resp.status} — ${text.slice(0, 200)}`);
        error.status = resp.status;
        throw error;
      }
      return { bucket: config.bucket, key, bytes: Buffer.byteLength(body, 'utf8') };
    }, {
      op: 'put',
      key,
    });
  }

  return withR2Retry(async () => {
    const { PutObjectCommand } = await loadS3SDK();
    const client = await getR2StorageClient(config);
    await withSettleTimeout(
      client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/json; charset=utf-8',
        CacheControl: 'no-store',
        Metadata: metadata,
      }), { abortSignal: AbortSignal.timeout(_s3TimeoutMs) }),
      _s3TimeoutMs,
      `R2 s3 put ${key}`,
    );
    return { bucket: config.bucket, key, bytes: Buffer.byteLength(body, 'utf8') };
  }, {
    op: 'put',
    key,
  });
}

async function getR2JsonObject(config, key) {
  if (config.mode === 'api') {
    return withR2Retry(async () => {
      const encodedKey = key.split('/').map(part => encodeURIComponent(part)).join('/');
      const resp = await fetch(`${config.apiBaseUrl}/accounts/${config.accountId}/r2/buckets/${config.bucket}/objects/${encodedKey}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (resp.status === 404) return null;
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        const error = new Error(`Cloudflare R2 API download failed: HTTP ${resp.status} — ${text.slice(0, 200)}`);
        error.status = resp.status;
        throw error;
      }
      return resp.json();
    }, {
      op: 'get',
      key,
    });
  }

  return withR2Retry(async () => {
    const { GetObjectCommand } = await loadS3SDK();
    const client = await getR2StorageClient(config);
    try {
      const response = await withSettleTimeout(
        client.send(new GetObjectCommand({
          Bucket: config.bucket,
          Key: key,
        }), { abortSignal: AbortSignal.timeout(_s3TimeoutMs) }),
        _s3TimeoutMs,
        `R2 s3 get ${key} send`,
      );
      const body = response.Body
        ? await withSettleTimeout(response.Body.transformToString(), _s3TimeoutMs, `R2 s3 get ${key} body`)
        : null;
      if (!body) return null;
      return JSON.parse(body);
    } catch (err) {
      if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NoSuchKey') return null;
      throw err;
    }
  }, {
    op: 'get',
    key,
  });
}

export {
  resolveR2StorageConfig,
  getR2StorageClient,
  getR2JsonObject,
  putR2JsonObject,
  withSettleTimeout,
  __setS3ClientForTests,
  __setR2S3TimeoutForTests,
};
