import { strict as assert } from 'node:assert';
import test from 'node:test';
import handler, { isValidChannel } from '../api/youtube/live.js';
 
const makeRequest = (query) => new Request(`https://api.worldmonitor.app/api/youtube/live${query}`);
 
test('accepts YouTube handles and canonical channel ids', () => {
  assert.equal(isValidChannel('@SkyNews'), true);
  assert.equal(isValidChannel('SkyNews'), true);
  assert.equal(isValidChannel('UCXuqSBlHAE6Xw-yeJA0Tunw'), true);
});
 
test('rejects channel values that escape the YouTube channel path', () => {
  assert.equal(isValidChannel('@x/../../watch?v=abc'), false);
  assert.equal(isValidChannel('@x?foo=bar'), false);
  assert.equal(isValidChannel('@x#frag'), false);
  assert.equal(isValidChannel('a'.repeat(200)), false);
  assert.equal(isValidChannel(''), false);
});
 
test('handler rejects malformed channel and videoId before any upstream fetch', async () => {
  const badChannel = await handler(makeRequest('?channel=%40x%2F..%2F..%2Fwatch'));
  assert.equal(badChannel.status, 400);
  assert.equal((await badChannel.json()).error, 'Invalid channel parameter');
 
  const badVideo = await handler(makeRequest('?videoId=notavalidid'));
  assert.equal(badVideo.status, 400);
  assert.equal((await badVideo.json()).error, 'Invalid videoId parameter');
 
  const empty = await handler(makeRequest(''));
  assert.equal(empty.status, 400);
});
