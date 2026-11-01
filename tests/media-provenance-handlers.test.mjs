// #9096 media provenance API: enqueue and poll, PRO-gated for any URL and
// secret-gated for an error report's link. Results are owner-bound.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { MEDIA_CAVEATS, MEDIA_QUEUE_KEY, mediaOwnerKey, mediaResultKey } from '../shared/media-provenance-contract.js';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const PRO_OWNER = await sha256Hex('media:key:pro-test-key');
const OPERATOR_OWNER = await sha256Hex('media:operator:trust-review');
const REPORT_ID = '0f8e2a1c-1111-4222-8333-444455556666';

function ctx(path, headers = {}) {
  return { request: new Request(`https://worldmonitor.app${path}`, { method: 'POST', headers }), pathParams: {}, headers };
}
const pro = (path) => ctx(path, { 'X-WorldMonitor-Key': 'pro-test-key' });
const operator = (path) => ctx(path, { 'X-Trust-Review-Key': 'review-secret' });

/** A fake Upstash: GET /get/<key> reads, a POSTed command list writes. */
function fakeUpstash(initial = {}) {
  const store = new Map(Object.entries(initial));
  const commands = [];
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes('/get/')) {
      const key = decodeURIComponent(href.split('/get/')[1]);
      return Response.json({ result: store.has(key) ? store.get(key) : null });
    }
    const body = JSON.parse(init?.body ?? '[]');
    const list = Array.isArray(body[0]) ? body : [body];
    commands.push(...list);
    return Response.json(list.map(([cmd, key, value]) => {
      if (cmd === 'LLEN') return { result: 0 };
      if (cmd === 'SET') { store.set(key, value); return { result: 'OK' }; }
      if (cmd === 'RPUSH') return { result: 1 };
      if (cmd === 'GET') return { result: store.get(key) ?? null };
      return { result: null };
    }));
  };
  return { store, commands };
}

let mod;
let gen;
let sideChannel;

describe('media provenance handlers', () => {
  beforeEach(async () => {
    process.env.WORLDMONITOR_VALID_KEYS = 'pro-test-key';
    process.env.TRUST_REVIEW_SECRET = 'review-secret';
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    delete process.env.LOCAL_API_MODE;
    mod = await import('../server/worldmonitor/news/v1/media-provenance.ts');
    gen = await import('../src/generated/server/worldmonitor/news/v1/service_server.ts');
    sideChannel = await import('../server/_shared/response-headers.ts');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });

  it('refuses a caller without PRO, and never queues', async () => {
    const upstash = fakeUpstash();
    await assert.rejects(
      mod.checkMediaProvenance(ctx('/api/news/v1/check-media-provenance'), { url: 'https://example.com/a.jpg' }),
      (error) => error instanceof gen.ApiError && error.statusCode === 403,
    );
    assert.equal(upstash.commands.length, 0);
  });

  it('rejects a URL that is not a public http(s) link before queueing', async () => {
    const upstash = fakeUpstash();
    for (const url of ['', 'ftp://example.com/a.jpg', 'https://user:pw@example.com/a.jpg', 'https://example.com:8443/a.jpg', 'http://intranet/a.jpg']) {
      await assert.rejects(
        mod.checkMediaProvenance(pro('/api/news/v1/check-media-provenance'), { url }),
        (error) => error instanceof gen.ValidationError && error.violations[0].field === 'url',
        url,
      );
    }
    assert.equal(upstash.commands.length, 0);
  });

  it('binds the owner and queues in one transaction, answering 202 with a Location', async () => {
    const upstash = fakeUpstash();
    const request = pro('/api/news/v1/check-media-provenance');
    const job = await mod.checkMediaProvenance(request, { url: ' https://example.com/a.jpg ' });
    assert.match(job.jobId, /^media:\d{13}:[a-f0-9]{32}$/);
    assert.equal(job.status, 'pending');
    assert.equal(job.statusUrl, `/api/news/v1/get-media-provenance?job_id=${encodeURIComponent(job.jobId)}`);
    assert.equal(sideChannel.drainSuccessStatusOverride(request.request), 202);
    const push = upstash.commands.find(([cmd]) => cmd === 'RPUSH');
    assert.equal(push[1], MEDIA_QUEUE_KEY);
    assert.deepEqual(JSON.parse(push[2]), { jobId: job.jobId, url: 'https://example.com/a.jpg', owner: PRO_OWNER, enqueuedAt: JSON.parse(push[2]).enqueuedAt });
    assert.equal(upstash.store.get(mediaOwnerKey(job.jobId)), JSON.stringify(PRO_OWNER));
  });

  it('serves a result only to its owner, and never trusts the stored caveats', async () => {
    const jobId = `media:1760616000000:${'a'.repeat(32)}`;
    fakeUpstash({
      [mediaOwnerKey(jobId)]: JSON.stringify(PRO_OWNER),
      [mediaResultKey(PRO_OWNER, jobId)]: JSON.stringify({
        status: 'done',
        result: {
          url: 'https://example.com/a.jpg', mediaType: 'image/jpeg', bytes: 10, sha256: 'b'.repeat(64), fetchedAt: '2026-10-16T12:00:00.000Z',
          credentials: { state: 'found', signer: 'Example', signerTrust: 'trusted', actions: [{ action: 'c2pa.created' }, { bogus: 1 }], failureCodes: [7, 'x'] },
          earliest: { state: 'ok', provider: 'TinEye', copies: [{ domain: 'example.org', pageUrl: 'javascript:alert(1)', crawlDate: '2024-01-01' }, { domain: 'example.org', pageUrl: 'https://example.org/p', crawlDate: '2024-01-01' }] },
          caveats: ['This image is authentic.'],
        },
      }),
    });
    const done = await mod.getMediaProvenance(pro('/api/news/v1/get-media-provenance'), { jobId });
    assert.equal(done.status, 'done');
    assert.deepEqual(done.result.caveats, [...MEDIA_CAVEATS]);
    assert.deepEqual(done.result.credentials.actions.map((a) => a.action), ['c2pa.created']);
    assert.deepEqual(done.result.credentials.failureCodes, ['x']);
    assert.deepEqual(done.result.earliest.copies.map((c) => c.pageUrl), ['https://example.org/p'], 'only http(s) pages');

    // Another principal's job reads as not found; the operator token is separate.
    await assert.rejects(
      mod.getReportMedia(operator('/api/news/v1/get-report-media'), { jobId }),
      (error) => error instanceof gen.ApiError && error.statusCode === 404,
    );
  });

  it('reports pending and failed checks', async () => {
    const pending = `media:1760616000000:${'c'.repeat(32)}`;
    const failed = `media:1760616000000:${'d'.repeat(32)}`;
    fakeUpstash({
      [mediaOwnerKey(pending)]: JSON.stringify(PRO_OWNER),
      [mediaOwnerKey(failed)]: JSON.stringify(PRO_OWNER),
      [mediaResultKey(PRO_OWNER, failed)]: JSON.stringify({ status: 'failed', error: 'The file is larger than 25 MB.' }),
    });
    assert.deepEqual(await mod.getMediaProvenance(pro('/x'), { jobId: pending }), { status: 'pending', error: '' });
    assert.deepEqual(await mod.getMediaProvenance(pro('/x'), { jobId: failed }), { status: 'failed', error: 'The file is larger than 25 MB.' });
    await assert.rejects(mod.getMediaProvenance(pro('/x'), { jobId: 'scenario:1:abc' }), (error) => error instanceof gen.ValidationError);
  });

  it('lets an operator check only the link a reader submitted with a report', async () => {
    await assert.rejects(
      mod.checkReportMedia(ctx('/api/news/v1/check-report-media'), { reportId: REPORT_ID }),
      (error) => error instanceof gen.ApiError && error.statusCode === 401,
    );
    const upstash = fakeUpstash({
      [`trust:report:v1:${REPORT_ID}`]: JSON.stringify({ id: REPORT_ID, status: 'pending', message: 'm', storyId: '', url: 'https://example.com/viral.jpg', contact: '', createdAt: 1, reviewedAt: 0, publicNote: '' }),
    });
    const job = await mod.checkReportMedia(operator('/api/news/v1/check-report-media'), { reportId: REPORT_ID });
    assert.equal(job.statusUrl, `/api/news/v1/get-report-media?job_id=${encodeURIComponent(job.jobId)}`);
    const payload = JSON.parse(upstash.commands.find(([cmd]) => cmd === 'RPUSH')[2]);
    assert.equal(payload.url, 'https://example.com/viral.jpg');
    assert.equal(payload.owner, OPERATOR_OWNER);
    assert.notEqual(OPERATOR_OWNER, PRO_OWNER);

    fakeUpstash({ [`trust:report:v1:${REPORT_ID}`]: JSON.stringify({ id: REPORT_ID, status: 'pending', message: 'm', storyId: '', url: '', contact: '', createdAt: 1, reviewedAt: 0, publicNote: '' }) });
    await assert.rejects(
      mod.checkReportMedia(operator('/api/news/v1/check-report-media'), { reportId: REPORT_ID }),
      (error) => error instanceof gen.ValidationError && /no link/.test(error.violations[0].description),
    );
  });
});
