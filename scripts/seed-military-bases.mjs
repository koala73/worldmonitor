#!/usr/bin/env node

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const BATCH_SIZE = 500;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
const PROGRESS_INTERVAL = 5000;
const GRACE_PERIOD_MS = 5 * 60 * 1000;
const VALIDATION_SAMPLE_SIZE = 10;

function parseArgs() {
  const args = process.argv.slice(2);
  let env = 'production';
  let sha = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--env' && args[i + 1]) {
      env = args[++i];
    } else if (args[i] === '--sha' && args[i + 1]) {
      sha = args[++i];
    } else if (args[i].startsWith('--env=')) {
      env = args[i].split('=')[1];
    } else if (args[i].startsWith('--sha=')) {
      sha = args[i].split('=')[1];
    }
  }

  const valid = ['production', 'preview', 'development'];
  if (!valid.includes(env)) {
    console.error(`Invalid --env "${env}". Must be one of: ${valid.join(', ')}`);
    process.exit(1);
  }

  if ((env === 'preview' || env === 'development') && !sha) {
    sha = 'dev';
  }

  return { env, sha };
}

function getKeyPrefix(env, sha) {
  if (env === 'production') return '';
  return `${env}:${sha}:`;
}

function maskToken(token) {
  if (!token || token.length < 8) return '***';
  return token.slice(0, 4) + '***' + token.slice(-4);
}

function loadEnvFile() {
  const envPath = join(__dirname, '..', '.env.local');
  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

async function pipelineRequest(url, token, commands, attempt = 1) {
  const body = JSON.stringify(commands);
  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    if (attempt < MAX_RETRIES) {
      const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
      console.warn(`  Pipeline failed (HTTP ${resp.status}), retry ${attempt}/${MAX_RETRIES} in ${delay}ms...`);
      await sleep(delay);
      return pipelineRequest(url, token, commands, attempt + 1);
    }
    throw new Error(`Pipeline failed after ${MAX_RETRIES} attempts: HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }

  return resp.json();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function seedGeo(url, token, geoKey, entries) {
  let seeded = 0;
  const total = entries.length;

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const commands = batch.map(e => ['GEOADD', geoKey, String(e.lon), String(e.lat), e.id]);
    await pipelineRequest(url, token, commands);
    seeded += batch.length;

    if (seeded % PROGRESS_INTERVAL === 0 || seeded === total) {
      console.log(`  GEO: ${seeded.toLocaleString()} / ${total.toLocaleString()}`);
    }
  }

  return seeded;
}

async function seedMeta(url, token, metaKey, entries) {
  let seeded = 0;
  const total = entries.length;

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const commands = batch.map(e => {
      const meta = { ...e };
      delete meta.id;
      return ['HSET', metaKey, e.id, JSON.stringify(meta)];
    });
    await pipelineRequest(url, token, commands);
    seeded += batch.length;

    if (seeded % PROGRESS_INTERVAL === 0 || seeded === total) {
      console.log(`  META: ${seeded.toLocaleString()} / ${total.toLocaleString()}`);
    }
  }

  return seeded;
}

async function validate(url, token, prefix, version, expectedCount) {
  const geoKey = `${prefix}military:bases:geo:${version}`;
  const metaKey = `${prefix}military:bases:meta:${version}`;

  console.log('\nValidating seeded data...');

  const [zcardResult, hlenResult] = await pipelineRequest(url, token, [
    ['ZCARD', geoKey],
    ['HLEN', metaKey],
  ]);

  const geoCount = zcardResult.result;
  const metaCount = hlenResult.result;

  console.log(`  ZCARD ${geoKey} = ${geoCount} (expected >= ${expectedCount})`);
  console.log(`  HLEN  ${metaKey} = ${metaCount} (expected == ZCARD)`);

  if (geoCount < expectedCount) {
    throw new Error(`GEO count ${geoCount} < expected ${expectedCount}`);
  }

  if (metaCount !== geoCount) {
    throw new Error(`META count ${metaCount} != GEO count ${geoCount}`);
  }

  const membersResult = await pipelineRequest(url, token, [
    ['ZRANDMEMBER', geoKey, String(VALIDATION_SAMPLE_SIZE)],
  ]);

  const sampleIds = membersResult[0].result;
  if (!sampleIds || sampleIds.length === 0) {
    throw new Error('ZRANDMEMBER returned no members');
  }

  const hmgetResult = await pipelineRequest(url, token, [
    ['HMGET', metaKey, ...sampleIds],
  ]);

  const values = hmgetResult[0].result;
  let parseOk = 0;
  for (let i = 0; i < values.length; i++) {
    if (!values[i]) {
      throw new Error(`Sample ID "${sampleIds[i]}" missing from META hash`);
    }
    try {
      JSON.parse(values[i]);
      parseOk++;
    } catch {
      throw new Error(`Sample ID "${sampleIds[i]}" has invalid JSON in META hash`);
    }
  }

  console.log(`  Sampled ${parseOk}/${sampleIds.length} entries — all valid JSON`);
  console.log('  Validation passed.');
}

async function atomicSwitch(url, token, prefix, version) {
  const activeKey = `${prefix}military:bases:active`;
  await pipelineRequest(url, token, [['SET', activeKey, String(version)]]);
  console.log(`\nAtomic switch: SET ${activeKey} = ${version}`);
}

async function cleanupOldVersion(url, token, prefix, newVersion) {
  const activeKey = `${prefix}military:bases:active`;
  const getResult = await pipelineRequest(url, token, [['GET', activeKey]]);
  const currentActive = getResult[0].result;

  if (!currentActive || String(currentActive) === String(newVersion)) return null;

  const oldVersion = currentActive;
  const oldGeoKey = `${prefix}military:bases:geo:${oldVersion}`;
  const oldMetaKey = `${prefix}military:bases:meta:${oldVersion}`;

  return { oldVersion, oldGeoKey, oldMetaKey };
}

async function main() {
  loadEnvFile();

  const { env, sha } = parseArgs();
  const prefix = getKeyPrefix(env, sha);

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!redisUrl) {
    console.error('Missing UPSTASH_REDIS_REST_URL. Set it in .env.local or as an env var.');
    process.exit(1);
  }
  if (!redisToken) {
    console.error('Missing UPSTASH_REDIS_REST_TOKEN. Set it in .env.local or as an env var.');
    process.exit(1);
  }

  const dataPath = join(__dirname, 'data', 'military-bases-final.json');
  if (!existsSync(dataPath)) {
    console.error(`Data file not found: ${dataPath}`);
    process.exit(1);
  }

  const raw = readFileSync(dataPath, 'utf8');
  const entries = JSON.parse(raw);

  if (!Array.isArray(entries) || entries.length === 0) {
    console.error('Data file is empty or not a JSON array.');
    process.exit(1);
  }

  const invalid = entries.filter(e => !e.id || e.lat == null || e.lon == null);
  if (invalid.length > 0) {
    console.error(`Found ${invalid.length} entries missing id/lat/lon. First: ${JSON.stringify(invalid[0])}`);
    process.exit(1);
  }

  const version = Date.now();
  const geoKey = `${prefix}military:bases:geo:${version}`;
  const metaKey = `${prefix}military:bases:meta:${version}`;

  console.log('=== Military Bases Seed ===');
  console.log(`  Environment:  ${env}`);
  console.log(`  Prefix:       ${prefix || '(none — production)'}`);
  console.log(`  Redis URL:    ${redisUrl}`);
  console.log(`  Redis Token:  ${maskToken(redisToken)}`);
  console.log(`  Data file:    ${dataPath}`);
  console.log(`  Entries:      ${entries.length.toLocaleString()}`);
  console.log(`  Version:      ${version}`);
  console.log(`  GEO key:      ${geoKey}`);
  console.log(`  META key:     ${metaKey}`);
  console.log(`  Batch size:   ${BATCH_SIZE}`);
  console.log();

  const oldInfo = await cleanupOldVersion(redisUrl, redisToken, prefix, version);
  if (oldInfo) {
    console.log(`Previous version detected: ${oldInfo.oldVersion}`);
    console.log(`  Will clean up after grace period: ${oldInfo.oldGeoKey}, ${oldInfo.oldMetaKey}`);
  }

  console.log('Seeding GEO entries...');
  const t0 = Date.now();
  const geoSeeded = await seedGeo(redisUrl, redisToken, geoKey, entries);

  console.log('\nSeeding META entries...');
  const metaSeeded = await seedMeta(redisUrl, redisToken, metaKey, entries);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\nSeeding complete in ${elapsed}s — GEO: ${geoSeeded.toLocaleString()}, META: ${metaSeeded.toLocaleString()}`);

  await validate(redisUrl, redisToken, prefix, version, entries.length);

  await atomicSwitch(redisUrl, redisToken, prefix, version);

  if (oldInfo) {
    console.log(`\nScheduling cleanup of old version ${oldInfo.oldVersion} in ${GRACE_PERIOD_MS / 1000}s...`);
    await sleep(GRACE_PERIOD_MS);
    console.log(`Cleaning up old keys: ${oldInfo.oldGeoKey}, ${oldInfo.oldMetaKey}`);
    await pipelineRequest(redisUrl, redisToken, [
      ['DEL', oldInfo.oldGeoKey],
      ['DEL', oldInfo.oldMetaKey],
    ]);
    console.log('Old version cleaned up.');
  }

  console.log('\n=== Done ===');
  console.log(`  Active version: ${version}`);
  console.log(`  GEO key:        ${geoKey}`);
  console.log(`  META key:       ${metaKey}`);
  console.log(`  Total entries:  ${entries.length.toLocaleString()}`);
}

main().catch(err => {
  console.error('\nFATAL:', err.message || err);
  process.exit(1);
});
