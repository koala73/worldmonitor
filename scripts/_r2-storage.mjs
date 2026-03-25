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
  const accountId = getEnvValue(env, ['CLOUDFLARE_R2_ACCOUNT_ID']);
  const bucket = getEnvValue(env, [options.bucketEnv || 'CLOUDFLARE_R2_TRACE_BUCKET', 'CLOUDFLARE_R2_BUCKET']);
  const accessKeyId = getEnvValue(env, ['CLOUDFLARE_R2_ACCESS_KEY_ID']);
  const secretAccessKey = getEnvValue(env, ['CLOUDFLARE_R2_SECRET_ACCESS_KEY']);
  const apiToken = getEnvValue(env, ['CLOUDFLARE_R2_TOKEN', 'CLOUDFLARE_API_TOKEN']);
  const endpoint = getEnvValue(env, ['CLOUDFLARE_R2_ENDPOINT']) || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '');
  const apiBaseUrl = getEnvValue(env, ['CLOUDFLARE_API_BASE_URL']) || 'https://api.cloudflare.com/client/v4';
  const region = getEnvValue(env, ['CLOUDFLARE_R2_REGION']) || 'auto';
  const basePrefix = (getEnvValue(env, [options.prefixEnv || 'CLOUDFLARE_R2_TRACE_PREFIX']) || 'seed-data/forecast-traces')
    .replace(/^\/+|\/+$/g, '');
  const forcePathStyle = parseBoolean(getEnvValue(env, ['CLOUDFLARE_R2_FORCE_PATH_STYLE']), true);

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
    await client.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: body,
      ContentType: 'application/json; charset=utf-8',
      CacheControl: 'no-store',
      Metadata: metadata,
    }));
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
      const response = await client.send(new GetObjectCommand({
        Bucket: config.bucket,
        Key: key,
      }));
      const body = await response.Body?.transformToString?.();
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
};
