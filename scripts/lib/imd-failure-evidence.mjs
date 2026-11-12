import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { IMD_PRODUCTS, IMD_MAX_BYTES, assembleImdSnapshot, fetchImdBulletinPage } from './imd-cyclone-marine.mjs';

export const IMD_EVIDENCE_MAX_BYTES = 4 * 1024 * 1024;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const pages = Object.entries(IMD_PRODUCTS).flatMap(([productId, product]) =>
  (product.pages || []).map((page) => ({ productId, page })));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function runtimeIdentity() {
  return {
    parserSha256: hash(await readFile(new URL('./imd-cyclone-marine.mjs', import.meta.url))),
    lockSha256: hash(await readFile(new URL('../package-lock.json', import.meta.url))),
    node: process.version,
    deploymentCommit: /^[a-f0-9]{40}$/i.test(process.env.RAILWAY_GIT_COMMIT_SHA || '') ? process.env.RAILWAY_GIT_COMMIT_SHA : null,
  };
}

export async function createImdFailureCapture({ directory, runStartedAtMs = null } = {}) {
  if (!directory) return undefined;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const { page } of pages) {
    for (const extension of ['json', 'tmp']) {
      const path = join(directory, `${page.key}.${extension}`);
      try {
        if ((await stat(path)).mtimeMs < Date.now() - RETENTION_MS) await rm(path);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
  }
  const runtime = await runtimeIdentity();
  return async (input) => {
    if (!pages.some(({ productId, page }) => productId === input.productId && page.key === input.pageKey)) throw new Error('invalid evidence page');
    const bundle = { ...input, runtime, runStartedAtMs, capturedAt: Date.now(), captureId: randomUUID() };
    const bytes = Buffer.from(JSON.stringify(bundle));
    if (bytes.length > IMD_EVIDENCE_MAX_BYTES) throw new Error('evidence too large');
    const target = join(directory, `${input.pageKey}.json`);
    const temporary = join(directory, `${input.pageKey}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(bytes);
      await file.close();
      await rename(temporary, target);
    } finally {
      await file.close();
      await rm(temporary, { force: true });
    }
    console.info(JSON.stringify({ event: 'imd_failure_evidence', captureId: bundle.captureId, page: input.pageKey, runStartedAtMs, now: input.now }));
  };
}

export async function readImdFailure(path) {
  const file = await open(path, 'r');
  try {
    if ((await file.stat()).size > IMD_EVIDENCE_MAX_BYTES) throw new Error('evidence too large');
    const bytes = Buffer.alloc(IMD_EVIDENCE_MAX_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > IMD_EVIDENCE_MAX_BYTES) throw new Error('evidence too large');
    return JSON.parse(bytes.subarray(0, size).toString());
  } finally {
    await file.close();
  }
}

export async function replayImdFailure(bundle, { allowRevisionMismatch = false } = {}) {
  const registered = pages.find(({ productId, page }) => productId === bundle?.productId && page.key === bundle?.pageKey);
  if (bundle?.schemaVersion !== 1 || !registered || !Number.isFinite(bundle.now)
    || !Array.isArray(bundle.attempts) || bundle.attempts.length < 1 || bundle.attempts.length > 2) throw new Error('invalid evidence bundle');
  const runtime = await runtimeIdentity();
  const runtimeMatches = ['parserSha256', 'lockSha256', 'node'].every((key) => runtime[key] === bundle.runtime?.[key]);
  if (!runtimeMatches && !allowRevisionMismatch) throw new Error('runtime revision mismatch; use the captured revision or explicitly allow comparison');
  for (const [index, attempt] of bundle.attempts.entries()) {
    if (!attempt || (attempt.status !== null && (!Number.isInteger(attempt.status) || attempt.status < 200 || attempt.status > 599))
      || (attempt.contentType !== null && (typeof attempt.contentType !== 'string' || /[\r\n]/.test(attempt.contentType)))) throw new Error('invalid evidence response');
    if (attempt.url !== (index === 0 ? registered.page.url : registered.page.fallbackUrl)) throw new Error('invalid evidence URL');
    if (attempt.bodyBase64 !== null && (typeof attempt.bodyBase64 !== 'string'
      || Buffer.byteLength(attempt.bodyBase64, 'base64') > IMD_MAX_BYTES
      || Buffer.from(attempt.bodyBase64, 'base64').toString('base64') !== attempt.bodyBase64)) throw new Error('invalid evidence body');
    const failedBeforeBody = attempt.status === null || attempt.status < 200 || attempt.status >= 300
      || (index === 1 && !/^application\/pdf(?:;|$)/i.test(attempt.contentType || ''));
    if (attempt.bodyBase64 === null && !failedBeforeBody) throw new Error('incomplete evidence body');
  }
  let index = 0;
  let missingResponse = false;
  const fetchFn = async (url) => {
    const attempt = bundle.attempts[index++];
    if (!attempt || attempt.url !== url) {
      missingResponse = true;
      throw new Error('missing replay response');
    }
    if (attempt.status === null) {
      const error = new Error('recorded transport failure');
      if (attempt.failure === 'IMD_FETCH_TIMEOUT') error.name = 'TimeoutError';
      throw error;
    }
    const body = attempt.bodyBase64 === null || [204, 205, 304].includes(attempt.status)
      ? null : Buffer.from(attempt.bodyBase64, 'base64');
    return new Response(body, { status: attempt.status, headers: { 'content-type': attempt.contentType || '' } });
  };
  const result = await fetchImdBulletinPage(bundle.productId, registered.page, { fetchFn, delayMs: 0 });
  if (missingResponse || index !== bundle.attempts.length) throw new Error('replay response count mismatch');
  const snapshot = assembleImdSnapshot({ pageResults: { [bundle.productId]: { [bundle.pageKey]: result } }, previous: bundle.previous, now: bundle.now });
  return { runtimeMatches, result, page: snapshot.products[bundle.productId].pages[bundle.pageKey], records: snapshot.records.filter((row) => row.page === bundle.pageKey) };
}
