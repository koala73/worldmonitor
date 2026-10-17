// #9096 media provenance: the worker's checks (scripts/lib/media-provenance.mjs,
// scripts/media-provenance-worker.mjs) and the wording they report with.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { lookup as dnsLookup } from 'node:dns';
import { createServer } from 'node:net';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { lauxlib, lua, lualib, to_jsstring, to_luastring } from 'fengari';

import sharp from 'sharp';

import {
  MEDIA_CAVEATS,
  MEDIA_WORDING,
  tineyeCacheKey,
  tineyeSpendKey,
} from '../shared/media-provenance-contract.js';
import {
  MediaCheckError,
  fetchMedia,
  findEarliestCopies,
  mediaUrlProblem,
  parseTinEyeResponse,
  readCredentials,
  requestOnce,
  sniffMediaType,
  strippedSearchBytes,
  summarizeCredentials,
  tineyeLimits,
} from '../scripts/lib/media-provenance.mjs';
import {
  claimJobLease,
  finalizeJob,
  JOB_MAX_RECOVERIES,
  mediaLeaseKey,
  mediaRecoveriesKey,
  mediaStorageKey,
  recoverAbandonedJobs,
  refreshJobLease,
  runMediaCheck,
  sweepExpiredMedia,
  withTimeLimit,
} from '../scripts/media-provenance-worker.mjs';
import { MEDIA_PROCESSING_KEY, MEDIA_QUEUE_KEY, mediaResultKey } from '../shared/media-provenance-contract.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/media-provenance/${name}`, import.meta.url), 'utf8'));

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(60)]);
const MOV = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  '), Buffer.alloc(60)]);
const HTML = Buffer.from('<!doctype html><html><body>not an image</body></html>');

/** A fake http(s).request result. */
function response(statusCode, headers = {}, body = Buffer.alloc(0)) {
  const res = new PassThrough();
  res.statusCode = statusCode;
  res.headers = headers;
  setImmediate(() => res.end(body));
  return res;
}

function scriptedRequest(routes) {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url: url.toString(), options });
    const route = routes[url.toString()];
    if (!route) throw Object.assign(new Error('unexpected host'), { code: 'ENOTFOUND' });
    return typeof route === 'function' ? route() : route;
  };
  return { request, calls };
}

function fakeRedis(initial = {}) {
  const store = new Map(Object.entries(initial));
  const log = [];
  const cmd = async (name, args) => {
    log.push([name, ...args]);
    return handle(name, args);
  };
  const handle = (name, args) => {
    const [key, value] = args;
    switch (name) {
      case 'get': return store.has(key) ? store.get(key) : null;
      case 'set': store.set(key, value); return 'OK';
      case 'incrby': store.set(key, Number(store.get(key) ?? 0) + Number(value)); return store.get(key);
      case 'decrby': store.set(key, Number(store.get(key) ?? 0) - Number(value)); return store.get(key);
      case 'expire': return 1;
      case 'eval': {
        const [script, count, ...rest] = args;
        const verbs = { INCRBY: 'incrby', DECRBY: 'decrby', EXPIRE: 'expire', GET: 'get', SET: 'set' };
        return evalLua(script, rest.slice(0, Number(count)), rest.slice(Number(count)), (verb, callArgs) => {
          const local = verbs[String(verb).toUpperCase()];
          if (!local) throw new Error(`fakeRedis eval does not implement ${verb}`);
          const out = handle(local, callArgs);
          return local === 'get' && out === null ? false : typeof out === 'string' && /^-?\d+$/.test(out) ? Number(out) : out;
        });
      }
      default: throw new Error(`unexpected ${name}`);
    }
  };
  return { cmd, store, log };
}

describe('media URLs (SSRF guard, form)', () => {
  it('accepts a public http(s) URL on the standard port', () => {
    assert.equal(mediaUrlProblem('https://example.com/photo.jpg'), null);
    assert.equal(mediaUrlProblem('http://cdn.example.org:80/a.png'), null);
  });

  it('refuses private, local and metadata hosts, credentials, other ports and schemes', () => {
    for (const url of [
      'http://127.0.0.1/a.jpg',
      'http://10.0.0.5/a.jpg',
      'http://192.168.1.1/a.jpg',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/a.jpg',
      'http://[::ffff:127.0.0.1]/a.jpg',
      'http://localhost/a.jpg',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://printer.local/a.jpg',
      'http://intranet/a.jpg',
      'https://user:pass@example.com/a.jpg',
      'https://example.com:8443/a.jpg',
      'ftp://example.com/a.jpg',
      'file:///etc/passwd',
      'not a url',
      `https://example.com/${'a'.repeat(2100)}`,
    ]) {
      assert.ok(mediaUrlProblem(url), url);
    }
  });
});

describe('media type sniffing', () => {
  it('reads the type from the bytes, not the header', () => {
    assert.equal(sniffMediaType(JPEG), 'image/jpeg');
    assert.equal(sniffMediaType(PNG), 'image/png');
    assert.equal(sniffMediaType(MP4), 'video/mp4');
    assert.equal(sniffMediaType(MOV), 'video/quicktime');
    assert.equal(sniffMediaType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)])), 'image/webp');
    assert.equal(sniffMediaType(HTML), null);
    assert.equal(sniffMediaType(Buffer.alloc(4)), null);
  });

  it('tells MP4 video apart from audio and still-image files in the same container', () => {
    const ftyp = (major, ...compatible) => {
      const body = Buffer.concat([Buffer.from(`ftyp${major}`), Buffer.alloc(4), ...compatible.map((b) => Buffer.from(b))]);
      const size = Buffer.alloc(4);
      size.writeUInt32BE(body.length + 4);
      return Buffer.concat([size, body, Buffer.alloc(32)]);
    };
    assert.equal(sniffMediaType(ftyp('M4A ', 'M4A ', 'mp42', 'isom')), null, 'an m4a is audio, not video');
    assert.equal(sniffMediaType(ftyp('mif1', 'mif1', 'avif')), 'image/avif', 'a compatible brand counts');
    assert.equal(sniffMediaType(ftyp('heic', 'mif1', 'heic')), 'image/heic');
    assert.equal(sniffMediaType(ftyp('mp42', 'isom')), 'video/mp4');
  });
});

describe('fetching media', () => {
  it('downloads an image, hashes it and routes every connection through the guarded lookup', async () => {
    const lookup = () => {};
    const { request, calls } = scriptedRequest({ 'https://example.com/a.jpg': () => response(200, { 'content-type': 'text/html' }, JPEG) });
    const fetched = await fetchMedia('https://example.com/a.jpg', { request, lookup });
    assert.equal(fetched.mediaType, 'image/jpeg', 'sniffed, despite the text/html header');
    assert.match(fetched.sha256, /^[a-f0-9]{64}$/);
    assert.equal(calls[0].options.lookup, lookup);
  });

  it('re-checks every redirect and refuses one that points inside the network', async () => {
    const { request, calls } = scriptedRequest({
      'https://example.com/a.jpg': () => response(302, { location: 'http://169.254.169.254/latest/meta-data/' }),
    });
    await assert.rejects(fetchMedia('https://example.com/a.jpg', { request }), (error) => error instanceof MediaCheckError && error.code === 'url');
    assert.equal(calls.length, 1, 'the metadata address is never requested');
  });

  it('follows a public redirect, up to the limit', async () => {
    const { request } = scriptedRequest({
      'https://example.com/a': () => response(301, { location: '/b' }),
      'https://example.com/b': () => response(200, {}, PNG),
    });
    assert.equal((await fetchMedia('https://example.com/a', { request })).mediaType, 'image/png');
    const loop = scriptedRequest({ 'https://example.com/a': () => response(302, { location: '/a' }) });
    await assert.rejects(fetchMedia('https://example.com/a', { request: loop.request, maxRedirects: 2 }), /redirects too many times/);
  });

  it('refuses a DNS answer the guarded lookup blocks', async () => {
    const request = async () => { throw Object.assign(new Error('blocked'), { code: 'ERR_SSRF_BLOCKED' }); };
    await assert.rejects(fetchMedia('https://rebind.example.com/a.jpg', { request }), /public website/);
  });

  it('refuses files over the size limit, by header and while streaming', async () => {
    const declared = scriptedRequest({ 'https://example.com/a.jpg': () => response(200, { 'content-length': '999999999' }, JPEG) });
    await assert.rejects(fetchMedia('https://example.com/a.jpg', { request: declared.request }), (e) => e.code === 'too-large');
    const streamed = scriptedRequest({ 'https://example.com/a.jpg': () => response(200, {}, Buffer.concat([JPEG, Buffer.alloc(200)])) });
    await assert.rejects(fetchMedia('https://example.com/a.jpg', { request: streamed.request, maxBytes: 100 }), (e) => e.code === 'too-large');
  });

  it('gives up on a server that drips bytes past the overall deadline', async () => {
    const drip = scriptedRequest({ 'https://example.com/a.jpg': () => {
      const res = new PassThrough();
      res.statusCode = 200;
      res.headers = {};
      res.write(JPEG.subarray(0, 4));
      return res;
    } });
    await assert.rejects(fetchMedia('https://example.com/a.jpg', { request: drip.request, deadlineMs: 50 }), (e) => e.code === 'timeout');
  });

  it('holds every request to the overall deadline, headers included', async () => {
    // A server that drips header bytes never trips the socket idle timeout.
    const server = createServer((socket) => {
      socket.write('HTTP/1.1 200 OK\r\n');
      const drip = setInterval(() => socket.write('X'), 10);
      socket.on('close', () => clearInterval(drip));
      socket.on('error', () => clearInterval(drip));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const started = Date.now();
      await assert.rejects(
        requestOnce(new URL(`http://127.0.0.1:${server.address().port}/a.jpg`), { lookup: dnsLookup, timeoutMs: 5_000, deadlineAt: Date.now() + 150 }),
        (e) => e instanceof MediaCheckError && e.code === 'timeout',
      );
      assert.ok(Date.now() - started < 2_000, 'the deadline, not the idle timeout, ended it');
    } finally {
      server.close();
    }
    const { request, calls } = scriptedRequest({ 'https://example.com/a.jpg': () => response(200, {}, JPEG) });
    await fetchMedia('https://example.com/a.jpg', { request, deadlineMs: 60_000 });
    assert.ok(Math.abs(calls[0].options.deadlineAt - (Date.now() + 60_000)) < 5_000, 'fetchMedia passes its deadline to each request');
  });

  it('closes a discarded response instead of draining it', async () => {
    const redirect = response(302, { location: '/b' });
    const missing = response(404);
    const huge = response(200, { 'content-length': '999999999' }, JPEG);
    const { request } = scriptedRequest({
      'https://example.com/a': () => redirect,
      'https://example.com/b': () => missing,
      'https://example.com/c': () => huge,
    });
    await assert.rejects(fetchMedia('https://example.com/a', { request }), /HTTP 404/);
    await assert.rejects(fetchMedia('https://example.com/c', { request }), (e) => e.code === 'too-large');
    assert.ok(redirect.destroyed && missing.destroyed && huge.destroyed);
  });

  it('reports a connection that closes before the body ends as a failed download', async () => {
    const cut = () => {
      const res = new PassThrough();
      res.statusCode = 200;
      res.headers = {};
      setImmediate(() => { res.write(JPEG.subarray(0, 8)); res.destroy(); });
      return res;
    };
    const { request } = scriptedRequest({ 'https://example.com/a.jpg': cut });
    await assert.rejects(fetchMedia('https://example.com/a.jpg', { request }), (error) => error instanceof MediaCheckError && error.code === 'fetch');
  });

  it('refuses a page that is not an image or video, and an error status', async () => {
    const page = scriptedRequest({ 'https://example.com/a': () => response(200, { 'content-type': 'image/jpeg' }, HTML) });
    await assert.rejects(fetchMedia('https://example.com/a', { request: page.request }), (e) => e.code === 'type');
    const missing = scriptedRequest({ 'https://example.com/a': () => response(404) });
    await assert.rejects(fetchMedia('https://example.com/a', { request: missing.request }), /HTTP 404/);
  });
});

describe('content credentials', () => {
  it('reports a trusted signer, the declared actions and the AI declaration (real c2pa-node output)', () => {
    const summary = summarizeCredentials(fixture('c2pa-store-trusted.json'), { trustListConfigured: true });
    assert.equal(summary.state, 'found');
    assert.equal(summary.signer, 'Example Newsroom (test)');
    assert.equal(summary.signerCommonName, 'Example Newsroom Signer');
    assert.equal(summary.signerTrust, 'trusted');
    assert.equal(summary.claimGenerator, 'WorldMonitor test fixture 1.0');
    assert.deepEqual(summary.actions.map((a) => a.action), ['c2pa.created', 'c2pa.cropped']);
    assert.equal(summary.actions[0].softwareAgent, 'Example Image Model');
    assert.equal(summary.declaresAiGeneration, true, 'the manifest declares trainedAlgorithmicMedia');
    assert.equal(summary.validationState, 'trusted');
    assert.equal(summary.contentChangedAfterSigning, false);
  });

  it('tells "not on the trust list" apart from "not checked"', () => {
    const store = fixture('c2pa-store-untrusted.json');
    assert.equal(summarizeCredentials(store, { trustListConfigured: true }).signerTrust, 'untrusted');
    assert.equal(summarizeCredentials(store, { trustListConfigured: false }).signerTrust, 'unknown');
  });

  it('reports a file changed after signing only from a hash mismatch', () => {
    const summary = summarizeCredentials(fixture('c2pa-store-tampered.json'));
    assert.equal(summary.validationState, 'invalid');
    assert.equal(summary.contentChangedAfterSigning, true);
    assert.ok(summary.failureCodes.includes('assertion.dataHash.mismatch'));
    assert.equal(summarizeCredentials(fixture('c2pa-store-untrusted.json')).contentChangedAfterSigning, false, 'an untrusted signer is not a changed file');
    // A trusted signer stays trusted when the file was changed after signing.
    const trustedButChanged = summarizeCredentials(fixture('c2pa-store-tampered-trusted.json'), { trustListConfigured: true });
    assert.deepEqual([trustedButChanged.signerTrust, trustedButChanged.validationState, trustedButChanged.contentChangedAfterSigning], ['trusted', 'invalid', true]);
  });

  it('treats no manifest as the ordinary result and a broken one as unreadable', async () => {
    assert.deepEqual(summarizeCredentials(null), { state: 'none' });
    assert.deepEqual(summarizeCredentials({ manifests: {} }), { state: 'unreadable' });
    assert.deepEqual(await readCredentials('/x', 'image/jpeg', async () => { throw new Error('JumbfNotFound'); }), { state: 'none' });
    assert.deepEqual(await readCredentials('/x', 'image/jpeg', async () => { throw new Error('ClaimDecoding'); }), { state: 'unreadable' });
  });
});

describe('earliest copies (TinEye)', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  const limits = { capCents: 5000, costCents: 4 };

  it('lists copies oldest first, once each, with dated http(s) pages only', () => {
    const parsed = parseTinEyeResponse(fixture('tineye-search.json'));
    assert.deepEqual(parsed.copies.map((c) => [c.crawlDate, c.pageUrl]), [
      ['2024-03-03', 'https://example.org/2024/03/03/first'],
      ['2026-10-14', 'https://example.net/news/2026/10/14/story'],
      ['2026-10-15', 'https://example.net/gallery/1'],
    ]);
    assert.equal(parsed.totalMatches, 3);
    const paged = fixture('tineye-search.json');
    paged.stats.total_results = 57;
    assert.equal(parseTinEyeResponse(paged).totalMatches, 57, 'the provider total, not the page length');
    assert.equal(parseTinEyeResponse({ code: 401, messages: ['bad key'] }), null);
    assert.equal(parseTinEyeResponse(null), null);
  });

  it('defaults to the owner cap of $50 a month at about $0.04 a search', () => {
    assert.deepEqual(tineyeLimits({}), { capCents: 5000, costCents: 4 });
    assert.deepEqual(tineyeLimits({ TINEYE_MONTHLY_CAP_USD: '10', TINEYE_COST_PER_SEARCH_USD: '0.05' }), { capCents: 1000, costCents: 5 });
    assert.deepEqual(tineyeLimits({ TINEYE_MONTHLY_CAP_USD: '', TINEYE_COST_PER_SEARCH_USD: ' ' }), { capCents: 5000, costCents: 4 }, 'blank means unset');
    assert.equal(tineyeLimits({ TINEYE_MONTHLY_CAP_USD: '0' }).capCents, 0, 'an explicit 0 turns searches off');
    assert.equal(tineyeSpendKey(now), 'media-provenance:tineye-spend:v1:2026-10');
  });

  it('does not search video, or without a key', async () => {
    const redis = fakeRedis();
    const search = async () => { throw new Error('must not search'); };
    const base = { sha256: 'a'.repeat(64), searchBytes: async () => JPEG, apiKey: 'k', redisCmd: redis.cmd, searchTinEye: search, limits, now, cacheTtlSeconds: 60 };
    assert.equal((await findEarliestCopies({ ...base, mediaType: 'video/mp4' })).state, 'unsupported-media');
    assert.equal((await findEarliestCopies({ ...base, mediaType: 'image/jpeg', apiKey: '' })).state, 'not-configured');
    assert.equal(redis.log.length, 0);
  });

  it('serves a repeat image from the cache without spending', async () => {
    const sha = 'b'.repeat(64);
    const redis = fakeRedis({ [tineyeCacheKey(sha)]: JSON.stringify({ copies: [{ domain: 'example.org', pageUrl: 'https://example.org/x', crawlDate: '2024-01-01' }], totalMatches: 1, searchedAt: '2026-10-01T00:00:00.000Z' }) });
    const result = await findEarliestCopies({ sha256: sha, mediaType: 'image/jpeg', searchBytes: async () => JPEG, apiKey: 'k', redisCmd: redis.cmd, searchTinEye: async () => { throw new Error('must not search'); }, limits, now, cacheTtlSeconds: 60 });
    assert.equal(result.state, 'ok');
    assert.equal(result.searchedAt, '2026-10-01T00:00:00.000Z', 'shows when the search first ran');
    assert.ok(!redis.log.some(([name]) => name === 'incrby'));
  });

  it('reports the cap as reached instead of searching or skipping silently', async () => {
    const redis = fakeRedis({ [tineyeSpendKey(now)]: 4998 });
    const result = await findEarliestCopies({ sha256: 'c'.repeat(64), mediaType: 'image/png', searchBytes: async () => PNG, apiKey: 'k', redisCmd: redis.cmd, searchTinEye: async () => { throw new Error('must not search'); }, limits, now, cacheTtlSeconds: 60 });
    assert.equal(result.state, 'cap-reached');
    assert.equal(redis.store.get(tineyeSpendKey(now)), 4998, 'the reservation is returned');
  });

  it('spends one reservation per search, refunds a refused one, keeps one with no answer and caches a success', async () => {
    const failing = fakeRedis();
    const failed = await findEarliestCopies({ sha256: 'd'.repeat(64), mediaType: 'image/jpeg', searchBytes: async () => JPEG, apiKey: 'k', redisCmd: failing.cmd, searchTinEye: async () => ({ code: 500 }), limits, now, cacheTtlSeconds: 60 });
    assert.equal(failed.state, 'unavailable');
    assert.equal(failing.store.get(tineyeSpendKey(now)), 0);

    const timedOut = fakeRedis();
    const lost = await findEarliestCopies({ sha256: 'd'.repeat(64), mediaType: 'image/jpeg', searchBytes: async () => JPEG, apiKey: 'k', redisCmd: timedOut.cmd, searchTinEye: async () => { throw new DOMException('timed out', 'TimeoutError'); }, limits, now, cacheTtlSeconds: 60 });
    assert.equal(lost.state, 'unavailable');
    assert.equal(timedOut.store.get(tineyeSpendKey(now)), 4, 'a search with no answer may have been billed, so it stays counted');

    const redis = fakeRedis();
    const sent = [];
    const ok = await findEarliestCopies({ sha256: 'e'.repeat(64), mediaType: 'image/jpeg', searchBytes: async () => Buffer.from('stripped'), apiKey: 'key-1', redisCmd: redis.cmd, searchTinEye: async (bytes, key) => { sent.push([bytes.toString(), key]); return fixture('tineye-search.json'); }, limits, now, cacheTtlSeconds: 60 });
    assert.equal(ok.state, 'ok');
    assert.equal(ok.copies[0].crawlDate, '2024-03-03');
    assert.deepEqual(sent, [['stripped', 'key-1']], 'only the metadata-stripped copy is sent');
    assert.equal(redis.store.get(tineyeSpendKey(now)), 4);
    assert.ok(redis.store.has(tineyeCacheKey('e'.repeat(64))));
  });

  it('reports a copy it cannot prepare as unavailable, without spending', async () => {
    const redis = fakeRedis();
    const result = await findEarliestCopies({ sha256: 'f'.repeat(64), mediaType: 'image/jpeg', searchBytes: async () => { throw new Error('bad image'); }, apiKey: 'k', redisCmd: redis.cmd, searchTinEye: async () => { throw new Error('must not search'); }, limits, now, cacheTtlSeconds: 60 });
    assert.equal(result.state, 'unavailable');
    assert.equal(redis.store.has(tineyeSpendKey(now)), false);
  });

  it('shrinks a large image before sending it, and never enlarges a small one', async () => {
    const big = await sharp({ create: { width: 4000, height: 1000, channels: 3, background: '#336699' } }).png().toBuffer();
    const small = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#336699' } }).png().toBuffer();
    const bigMeta = await sharp(await strippedSearchBytes(big, 'image/png', sharp)).metadata();
    assert.deepEqual([bigMeta.width, bigMeta.height], [2000, 500]);
    const smallMeta = await sharp(await strippedSearchBytes(small, 'image/png', sharp)).metadata();
    assert.deepEqual([smallMeta.width, smallMeta.height], [40, 30]);
  });

  it('strips EXIF (camera, GPS) from the copy it sends', async () => {
    const withExif = await sharp({ create: { width: 16, height: 12, channels: 3, background: '#336699' } })
      .jpeg().withExif({ IFD0: { Make: 'TestCam', Model: 'X1' } }).toBuffer();
    assert.ok((await sharp(withExif).metadata()).exif, 'the source has EXIF');
    const stripped = await strippedSearchBytes(withExif, 'image/jpeg', sharp);
    assert.equal((await sharp(stripped).metadata()).exif, undefined);
  });
});

describe('a whole check (worker)', () => {
  it('reads credentials from a temporary file it then removes, and never fails on storage', async () => {
    let assetPath = '';
    let storedFor = '';
    const jobId = `media:1760616000000:${'a'.repeat(32)}`;
    const result = await runMediaCheck({ url: 'https://example.com/a.jpg', jobId }, {
      fetchMedia: async () => ({ bytes: JPEG, mediaType: 'image/jpeg', sha256: 'f'.repeat(64) }),
      storeOriginal: async (_fetched, id) => { storedFor = id; throw new Error('R2 down'); },
      readerFactory: async (path) => { assetPath = path; assert.ok(existsSync(path)); return fixture('c2pa-store-trusted.json'); },
      trustListConfigured: true,
      strippedSearchBytes: async () => JPEG,
      searchTinEye: async () => fixture('tineye-search.json'),
      tineyeApiKey: 'k',
      limits: { capCents: 5000, costCents: 4 },
      redisCmd: fakeRedis().cmd,
      now: () => Date.parse('2026-10-16T12:00:00Z'),
    });
    assert.equal(existsSync(assetPath), false, 'the temporary copy is deleted');
    assert.equal(storedFor, jobId, 'each job stores its own object');
    assert.equal(mediaStorageKey('f'.repeat(64), jobId), `media-provenance/v1/${'f'.repeat(64)}/media-1760616000000-${'a'.repeat(32)}`);
    assert.equal(result.credentials.signerTrust, 'trusted');
    assert.equal(result.earliest.state, 'ok');
    assert.equal(result.bytes, JPEG.length);
    assert.deepEqual(result.caveats, [...MEDIA_CAVEATS]);
  });

  it('deletes stored files once they pass the 30-day retention', async () => {
    const now = Date.parse('2026-10-16T12:00:00Z');
    const calls = [];
    const deleted = [];
    const redisCmd = async (name, args) => {
      calls.push([name, ...args]);
      if (name === 'zrangebyscore') return ['media-provenance/v1/aaa', 'unrelated/key'];
      return 1;
    };
    assert.equal(await sweepExpiredMedia({ redisCmd, deleteObject: async (key) => { deleted.push(key); }, now }), 1);
    assert.deepEqual(deleted, ['media-provenance/v1/aaa'], 'only this feature\'s prefix is ever deleted');
    assert.equal(calls[0][3], now - 30 * 24 * 60 * 60 * 1000);
  });

  it('pushes a failed delete back an hour so it cannot block the files behind it', async () => {
    const now = Date.parse('2026-10-16T12:00:00Z');
    const calls = [];
    const redisCmd = async (name, args) => {
      calls.push([name, ...args]);
      return name === 'zrangebyscore' ? ['media-provenance/v1/stuck', 'media-provenance/v1/next'] : 1;
    };
    const deleteObject = async (key) => { if (key.endsWith('stuck')) throw new Error('R2 500'); };
    assert.equal(await sweepExpiredMedia({ redisCmd, deleteObject, now }), 1);
    assert.deepEqual(calls.find(([name]) => name === 'zadd'), ['zadd', 'media-provenance:stored:v1', now - 30 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000, 'media-provenance/v1/stuck']);
    assert.deepEqual(calls.filter(([name]) => name === 'zrem').map((c) => c[2]), ['media-provenance/v1/next']);
  });

  it('re-queues only claimed jobs whose lease has lapsed, in one atomic step', async () => {
    const live = JSON.stringify({ jobId: `media:1760616000000:${'1'.repeat(32)}`, url: 'https://example.com/a.jpg', owner: 'b'.repeat(64) });
    const lapsed = JSON.stringify({ jobId: `media:1760616000000:${'2'.repeat(32)}`, url: 'https://example.com/b.jpg', owner: 'b'.repeat(64) });
    const redis = luaRedis({ [mediaLeaseKey(JSON.parse(live).jobId)]: 'token' }, { [MEDIA_PROCESSING_KEY]: [live, lapsed, 'garbage'], [MEDIA_QUEUE_KEY]: [] });
    const noWait = { sleep: async () => {} };
    assert.equal(await recoverAbandonedJobs(redis.cmd, noWait), 1);
    assert.deepEqual(redis.lists.get(MEDIA_PROCESSING_KEY), [live], 'a live worker keeps its job; garbage is dropped');
    assert.deepEqual(redis.lists.get(MEDIA_QUEUE_KEY), [lapsed]);
    assert.equal(await recoverAbandonedJobs(redis.cmd, noWait), 0, 'nothing is re-queued twice');
  });

  it('leaves a job alone when its lease appears between the two looks (claimed just now)', async () => {
    const jobId = `media:1760616000000:${'4'.repeat(32)}`;
    const fresh = JSON.stringify({ jobId, url: 'https://example.com/d.jpg', owner: 'b'.repeat(64) });
    const redis = luaRedis({}, { [MEDIA_PROCESSING_KEY]: [fresh], [MEDIA_QUEUE_KEY]: [] });
    // BLMOVE has moved the job; the claiming worker sets its lease while recovery waits.
    const recovered = await recoverAbandonedJobs(redis.cmd, { sleep: async () => { redis.strings.set(mediaLeaseKey(jobId), 'token'); } });
    assert.equal(recovered, 0);
    assert.deepEqual(redis.lists.get(MEDIA_PROCESSING_KEY), [fresh]);
    assert.deepEqual(redis.lists.get(MEDIA_QUEUE_KEY), []);
    assert.ok(redis.log.every(([name]) => name !== 'lpush'), 'the move happens inside the script, never as a separate push');
  });

  it('stops re-queuing a job that keeps stopping the worker, and reports it as failed', async () => {
    const owner = 'b'.repeat(64);
    const jobId = `media:1760616000000:${'5'.repeat(32)}`;
    const raw = JSON.stringify({ jobId, url: 'https://example.com/e.jpg', owner });
    const redis = luaRedis({ [mediaRecoveriesKey(jobId)]: String(JOB_MAX_RECOVERIES) }, { [MEDIA_PROCESSING_KEY]: [raw], [MEDIA_QUEUE_KEY]: [] });
    assert.equal(await recoverAbandonedJobs(redis.cmd, { sleep: async () => {} }), 0);
    assert.deepEqual(redis.lists.get(MEDIA_PROCESSING_KEY), []);
    assert.deepEqual(redis.lists.get(MEDIA_QUEUE_KEY), [], 'not re-queued');
    const saved = JSON.parse(redis.strings.get(mediaResultKey(owner, jobId)));
    assert.equal(saved.status, 'failed');
    assert.match(saved.error, /stopped unexpectedly/);
  });

  it('stops a check that runs past its time limit', async () => {
    assert.equal(await withTimeLimit(Promise.resolve('done'), 50), 'done');
    await assert.rejects(withTimeLimit(new Promise(() => {}), 10), (error) => error instanceof MediaCheckError && error.code === 'timeout');
  });

  it('lets only the claim that holds the lease refresh it or save the final status', async () => {
    const jobId = `media:1760616000000:${'3'.repeat(32)}`;
    const raw = JSON.stringify({ jobId, url: 'https://example.com/c.jpg', owner: 'b'.repeat(64) });
    const redis = luaRedis({}, { [MEDIA_PROCESSING_KEY]: [raw], [MEDIA_QUEUE_KEY]: [] });
    await claimJobLease(redis.cmd, jobId, 'first');
    assert.equal(await refreshJobLease(redis.cmd, jobId, 'first'), true);
    // The lease lapsed and recovery handed the job to a second claim.
    redis.strings.set(mediaLeaseKey(jobId), 'second');
    assert.equal(await refreshJobLease(redis.cmd, jobId, 'first'), false);
    const args = { jobId, resultKey: 'media-provenance:result:x', raw };
    assert.equal(await finalizeJob(redis.cmd, { ...args, token: 'first', payload: { status: 'done', by: 'first' } }), false);
    assert.equal(redis.strings.has('media-provenance:result:x'), false, 'the stale claim writes nothing');
    assert.equal(await finalizeJob(redis.cmd, { ...args, token: 'second', payload: { status: 'done', by: 'second' } }), true);
    assert.equal(JSON.parse(redis.strings.get('media-provenance:result:x')).by, 'second');
    assert.deepEqual(redis.lists.get(MEDIA_PROCESSING_KEY), [], 'the claim is released with the save');
    assert.equal(redis.strings.has(mediaLeaseKey(jobId)), false);
  });
});

/** Run a Lua script the way Redis would, with `call(verb, args)` as redis.call (fengari). */
const pushLua = (L, value) => {
  if (value === false || value == null) lua.lua_pushboolean(L, false);
  else if (typeof value === 'number') lua.lua_pushnumber(L, value);
  else if (typeof value === 'string') lua.lua_pushstring(L, to_luastring(value));
  else {
    lua.lua_createtable(L, value.length, 0);
    value.forEach((entry, i) => { pushLua(L, entry); lua.lua_seti(L, -2, i + 1); });
  }
};

function evalLua(script, keys, argv, call) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  lua.lua_createtable(L, 0, 1);
  lua.lua_pushjsclosure(L, (S) => {
    const args = [];
    for (let i = 2; i <= lua.lua_gettop(S); i += 1) args.push(to_jsstring(lua.lua_tostring(S, i)));
    pushLua(S, call(to_jsstring(lua.lua_tostring(S, 1)), args));
    return 1;
  }, 0);
  lua.lua_setfield(L, -2, to_luastring('call'));
  lua.lua_setglobal(L, to_luastring('redis'));
  pushLua(L, keys);
  lua.lua_setglobal(L, to_luastring('KEYS'));
  pushLua(L, argv.map(String));
  lua.lua_setglobal(L, to_luastring('ARGV'));
  if (lauxlib.luaL_loadstring(L, to_luastring(script)) !== lua.LUA_OK || lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK) {
    throw new Error(`Lua: ${to_jsstring(lua.lua_tostring(L, -1))}`);
  }
  return lua.lua_tonumber(L, -1);
}

/** An in-memory Redis whose EVAL runs the real Lua script (fengari). */
function luaRedis(strings = {}, lists = {}) {
  const state = { strings: new Map(Object.entries(strings)), lists: new Map(Object.entries(lists).map(([k, v]) => [k, [...v]])), log: [] };
  const call = (name, args) => {
    const verb = String(name).toUpperCase();
    const list = () => state.lists.get(args[0]) ?? [];
    switch (verb) {
      case 'GET': return state.strings.has(args[0]) ? state.strings.get(args[0]) : false;
      case 'SET': state.strings.set(args[0], String(args[1])); return 'OK';
      case 'EXISTS': return state.strings.has(args[0]) ? 1 : 0;
      case 'EXPIRE': return state.strings.has(args[0]) ? 1 : 0;
      case 'INCR': state.strings.set(args[0], String(Number(state.strings.get(args[0]) ?? 0) + 1)); return Number(state.strings.get(args[0]));
      case 'DEL': return state.strings.delete(args[0]) ? 1 : 0;
      case 'LRANGE': return [...list()];
      case 'LPUSH': state.lists.set(args[0], [String(args[1]), ...list()]); return list().length;
      case 'LREM': {
        const items = list();
        const at = items.indexOf(String(args[2]));
        if (at < 0) return 0;
        items.splice(at, 1);
        state.lists.set(args[0], items);
        return 1;
      }
      default: throw new Error(`luaRedis does not implement ${verb}`);
    }
  };
  const cmd = async (name, args) => {
    state.log.push([name, ...args]);
    if (name === 'eval') {
      const [script, count, ...rest] = args;
      return evalLua(script, rest.slice(0, Number(count)), rest.slice(Number(count)), call);
    }
    return call(name, args);
  };
  return { ...state, cmd };
}

describe('wording (#9091: evidence, never a verdict)', () => {
  it('never calls media authentic, fake, verified or original', () => {
    for (const line of [...MEDIA_CAVEATS, ...Object.values(MEDIA_WORDING)]) {
      assert.doesNotMatch(line, /\b(authentic|fake|verified|original|manipulated|real)\b/i, line);
    }
    assert.match(MEDIA_WORDING.noCredentials, /common and says nothing about whether the media was edited/);
  });

  it('shows the fixed caveats in the published OpenAPI example', () => {
    const spec = JSON.parse(readFileSync(new URL('../docs/api/NewsService.openapi.json', import.meta.url), 'utf8'));
    const example = spec.paths['/api/news/v1/get-media-provenance'].get.responses['200'].content['application/json'].example;
    assert.deepEqual(example.result.caveats, [...MEDIA_CAVEATS]);
    assert.equal(example.result.credentials.state, 'found');
  });
});
