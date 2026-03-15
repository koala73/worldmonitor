#!/usr/bin/env node

let _S3Client, _PutObjectCommand;
async function loadS3SDK() {
  if (!_S3Client) {
    const sdk = await import('@aws-sdk/client-s3');
    _S3Client = sdk.S3Client;
    _PutObjectCommand = sdk.PutObjectCommand;
  }
  return { S3Client: _S3Client, PutObjectCommand: _PutObjectCommand };
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
      throw new Error(`Cloudflare R2 API upload failed: HTTP ${resp.status} — ${text.slice(0, 200)}`);
    }
    return { bucket: config.bucket, key, bytes: Buffer.byteLength(body, 'utf8') };
  }

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
}

export {
  resolveR2StorageConfig,
  getR2StorageClient,
  putR2JsonObject,
};
