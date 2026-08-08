import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { mcpErrorFingerprint } from '../api/mcp/error-fingerprint.ts';

// Regression guard for WORLDMONITOR-T8: the minified edge bundle gives every
// api/mcp error identical anonymous frames, so without an explicit fingerprint
// Sentry merges all tool 4xx/5xx sibling-fetch failures into one catch-all
// issue. These assertions pin the grouping so a future regex edit can't
// silently re-merge the groups.
describe('mcpErrorFingerprint', () => {
  it('keys a sibling-fetch HTTP error on <endpoint>:<status>', () => {
    assert.deepEqual(
      mcpErrorFingerprint('tool-execution', 'get_world_brief', new Error('feed-digest HTTP 404')),
      ['mcp-tool-execution', 'get_world_brief', 'feed-digest:404'],
    );
  });

  it('drops a trailing `: <reason>` so HTTP 401 variants coalesce', () => {
    const plain = mcpErrorFingerprint(
      'tool-execution',
      'get_country_brief',
      new Error('get-country-intel-brief HTTP 401'),
    );
    const withReason = mcpErrorFingerprint(
      'tool-execution',
      'get_country_brief',
      new Error('get-country-intel-brief HTTP 401: invalid_internal_mcp_signature'),
    );
    assert.deepEqual(plain, withReason);
    assert.deepEqual(plain, ['mcp-tool-execution', 'get_country_brief', 'get-country-intel-brief:401']);
  });

  it('separates the same tool by status class (401 auth vs 502 upstream)', () => {
    const four = mcpErrorFingerprint('tool-execution', 't', new Error('feed-digest HTTP 401'));
    const five = mcpErrorFingerprint('tool-execution', 't', new Error('feed-digest HTTP 502'));
    assert.notDeepEqual(four, five);
    assert.equal(four[2], 'feed-digest:401');
    assert.equal(five[2], 'feed-digest:502');
  });

  it('separates different tools that hit the same inner endpoint', () => {
    const a = mcpErrorFingerprint('tool-execution', 'get_world_brief', new Error('summarize-article HTTP 401'));
    const b = mcpErrorFingerprint('tool-execution', 'get_country_brief', new Error('summarize-article HTTP 401'));
    assert.notDeepEqual(a, b);
  });

  it('keeps underscore sibling endpoints on the HTTP grouping path', () => {
    assert.deepEqual(
      mcpErrorFingerprint('tool-execution', 'get_world_brief', new Error('feed_digest HTTP 404')),
      ['mcp-tool-execution', 'get_world_brief', 'feed_digest:404'],
    );
  });

  it('keys non-HTTP failures on the stable error name', () => {
    const timeout = new DOMException('The operation timed out', 'TimeoutError');
    const abort = new DOMException('The operation was aborted', 'AbortError');
    assert.deepEqual(
      mcpErrorFingerprint('tool-execution', 'get_world_brief', timeout),
      ['mcp-tool-execution', 'get_world_brief', 'TimeoutError'],
    );
    assert.deepEqual(
      mcpErrorFingerprint('tool-execution', 'get_world_brief', abort),
      ['mcp-tool-execution', 'get_world_brief', 'AbortError'],
    );
    assert.deepEqual(
      mcpErrorFingerprint('post-filter', 'get_market_data', new TypeError('x is not a function')),
      ['mcp-post-filter', 'get_market_data', 'TypeError'],
    );
  });

  it('handles a thrown non-Error value without crashing', () => {
    assert.deepEqual(
      mcpErrorFingerprint('tool-execution', 'get_world_brief', 'boom'),
      ['mcp-tool-execution', 'get_world_brief', 'non-error'],
    );
  });

  it('distinguishes the two capture steps', () => {
    const exec = mcpErrorFingerprint('tool-execution', 't', new Error('feed-digest HTTP 404'));
    const post = mcpErrorFingerprint('post-filter', 't', new Error('feed-digest HTTP 404'));
    assert.equal(exec[0], 'mcp-tool-execution');
    assert.equal(post[0], 'mcp-post-filter');
    assert.notDeepEqual(exec, post);
  });
});
