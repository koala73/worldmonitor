import test from 'node:test';
import assert from 'node:assert/strict';

import { getClientIp } from '../server/_shared/rate-limit';

function makeRequest(headersInit: Record<string, string>): Request {
  return new Request('https://worldmonitor.app/api/test', {
    headers: new Headers(headersInit),
  });
}

test('getClientIp prefers x-real-ip', () => {
  const ip = getClientIp(makeRequest({
    'x-real-ip': '198.51.100.10',
    'cf-connecting-ip': '198.51.100.11',
    'x-forwarded-for': '198.51.100.12',
  }));

  assert.equal(ip, '198.51.100.10');
});

test('getClientIp falls back to cf-connecting-ip', () => {
  const ip = getClientIp(makeRequest({
    'cf-connecting-ip': '198.51.100.21',
    'x-forwarded-for': '198.51.100.22',
  }));

  assert.equal(ip, '198.51.100.21');
});

test('getClientIp ignores x-forwarded-for when trusted proxy headers are absent', () => {
  const ip = getClientIp(makeRequest({
    'x-forwarded-for': '198.51.100.31',
  }));

  assert.equal(ip, '0.0.0.0');
});
