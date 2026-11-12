import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createImdFailureCapture, replayImdFailure, readImdFailure, IMD_EVIDENCE_MAX_BYTES } from '../scripts/lib/imd-failure-evidence.mjs';
import { fetchImdBulletinPage, fetchImdCycloneMarine, IMD_PRODUCTS, parseImdBulletinHtml, assembleImdSnapshot } from '../scripts/lib/imd-cyclone-marine.mjs';

const now = Date.parse('2026-10-16T11:00:00Z');
const fixture = (name) => readFile(new URL(`./fixtures/imd/${name}`, import.meta.url));
const pages = Object.entries(IMD_PRODUCTS).flatMap(([id, product]) => (product.pages || []).map((page) => ({ id, page })));
const kerala = pages.find(({ page }) => page.fallbackUrl).page;

async function input() {
  const results = {};
  for (const { id, page } of pages) {
    (results[id] ??= {})[page.key] = { status: 'parsed', bulletin: parseImdBulletinHtml((await fixture(`${id}-${page.key}.html`)).toString(), id) };
  }
  const previous = assembleImdSnapshot({ pageResults: results, now });
  const fetchFn = async (url) => {
    if (url === kerala.fallbackUrl) return new Response('%PDF-invalid', { headers: { 'content-type': 'application/pdf' } });
    const { id, page } = pages.find(({ page }) => page.url === url);
    return new Response(await fixture(page.key === kerala.key ? 'coastalBulletin-kerala-missing-synoptic.html' : `${id}-${page.key}.html`));
  };
  return { previous, fetchFn, now, delayMs: 0 };
}

test('private bundle replays failure and carried records offline with original clocks', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'imd-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const captureFailure = await createImdFailureCapture({ directory, runStartedAtMs: now });
  const snapshot = await fetchImdCycloneMarine({ ...await input(), captureFailure });
  const path = join(directory, `${kerala.key}.json`);
  const bundle = await readImdFailure(path);
  assert.equal(bundle.runStartedAtMs, now);
  assert.match(bundle.runtime.parserSha256, /^[a-f0-9]{64}$/);
  const lock = await readFile(new URL('../scripts/package-lock.json', import.meta.url));
  assert.equal(bundle.runtime.lockSha256, createHash('sha256').update(lock).digest('hex'));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  t.mock.method(globalThis, 'fetch', () => { throw new Error('network forbidden'); });
  const replay = await replayImdFailure(bundle);
  const cli = JSON.parse(execFileSync(process.execPath, ['scripts/replay-imd-failure.mjs', path], { encoding: 'utf8' }));
  assert.deepEqual(cli, replay);
  assert.deepEqual(replay.result, bundle.result);
  assert.deepEqual(replay.records, snapshot.records.filter((row) => row.page === kerala.key));
  assert.equal(replay.records.length, 4);
  const expired = await replayImdFailure({ ...bundle, now: Date.parse('2026-10-16T22:00:00Z') });
  assert.equal(expired.records.length, 0);
  assert.equal(replay.runtimeMatches, true);
  const sea = IMD_PRODUCTS.seaBulletin.pages[0];
  const expectedEmpty = await fetchImdBulletinPage('seaBulletin', sea, { fetchFn: async () => new Response(null, { status: 204 }) });
  const emptyReplay = await replayImdFailure({ ...bundle, productId: 'seaBulletin', pageKey: sea.key,
    attempts: [{ url: sea.url, status: 204, contentType: '', bodyBase64: '' }] });
  assert.deepEqual(emptyReplay.result, expectedEmpty);
  await assert.rejects(replayImdFailure({ ...bundle, runtime: { ...bundle.runtime, parserSha256: 'wrong' } }), /revision/);
  await assert.rejects(replayImdFailure({ ...bundle, attempts: bundle.attempts.map((a) => ({ ...a, bodyBase64: null })) }), /incomplete/);
  await assert.rejects(replayImdFailure({ ...bundle, attempts: [{ ...bundle.attempts[0], status: 999 }] }), /invalid/);
  await assert.rejects(replayImdFailure({ ...bundle, attempts: [bundle.attempts[0]] }), /response count/);
  await captureFailure(bundle);
  assert.deepEqual(await readdir(directory), [`${kerala.key}.json`]);
  await assert.rejects(captureFailure({ ...bundle, previous: { huge: 'x'.repeat(IMD_EVIDENCE_MAX_BYTES) } }), /large/);
  assert.deepEqual((await readImdFailure(path)).attempts, bundle.attempts);
  await utimes(path, new Date(0), new Date(0));
  await createImdFailureCapture({ directory });
  assert.deepEqual(await readdir(directory), []);
});

test('capture is opt-in and invalid replay files are rejected before parsing', async (t) => {
  assert.equal(await createImdFailureCapture({}), undefined);
  const directory = await mkdtemp(join(tmpdir(), 'imd-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'input.json');
  await writeFile(path, 'x'.repeat(IMD_EVIDENCE_MAX_BYTES + 1));
  await assert.rejects(readImdFailure(path), /large/);
  await assert.rejects(replayImdFailure({ schemaVersion: 99 }), /invalid/);
});
