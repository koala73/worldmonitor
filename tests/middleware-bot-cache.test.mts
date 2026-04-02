import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import middleware from '../middleware.ts';

describe('middleware bot responses', () => {
  it('does not make bot 403 responses publicly cacheable', () => {
    const res = middleware(new Request('https://worldmonitor.app/api/market/v1/list-market-quotes', {
      headers: { 'user-agent': 'curl/8.7.1' },
    }));
    assert.ok(res instanceof Response);
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('Cache-Control'), null);
  });

  it('does not make short user-agent 403 responses publicly cacheable', () => {
    const res = middleware(new Request('https://worldmonitor.app/api/market/v1/list-market-quotes', {
      headers: { 'user-agent': 'short' },
    }));
    assert.ok(res instanceof Response);
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('Cache-Control'), null);
  });
});
