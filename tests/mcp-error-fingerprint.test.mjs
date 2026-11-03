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

  it('does not classify status-only or other 401 reasons as signature failures', () => {
    for (const suffix of ['', ': insufficient_entitlement', ': invalid_api_key', ': unknown', ': invalid_internal_mcp_signature_extra']) {
      assert.deepEqual(
        mcpErrorFingerprint('tool-execution', 't', new Error(`feed-digest HTTP 401${suffix}`)),
        ['mcp-tool-execution', 't', 'feed-digest:401'],
      );
    }
  });

  it('separates the same tool by status class (401 auth vs 502 upstream)', () => {
    const four = mcpErrorFingerprint('tool-execution', 't', new Error('feed-digest HTTP 401: invalid_internal_mcp_signature'));
    const five = mcpErrorFingerprint('tool-execution', 't', new Error('feed-digest HTTP 502'));
    assert.notDeepEqual(four, five);
    assert.deepEqual(four, ['mcp-internal-auth-401']);
    assert.equal(five[2], 'feed-digest:502');
  });

  it('separates different tools that hit the same inner endpoint', () => {
    const a = mcpErrorFingerprint('tool-execution', 'get_world_brief', new Error('summarize-article HTTP 502'));
    const b = mcpErrorFingerprint('tool-execution', 'get_country_brief', new Error('summarize-article HTTP 502'));
    assert.notDeepEqual(a, b);
  });

  // Only confirmed signature/replay failures share the cross-tool group.
  describe('internal-MCP 401 coalescing', () => {
    it('groups a 401 identically across different tools and endpoints', () => {
      const tenders = mcpErrorFingerprint(
        'tool-execution', 'get_procurement_opportunities', new Error('list-global-tenders HTTP 401: invalid_internal_mcp_signature'),
      );
      const brief = mcpErrorFingerprint(
        'tool-execution', 'get_country_brief',
        new Error('get-country-intel-brief HTTP 401: invalid_internal_mcp_signature'),
      );
      const risk = mcpErrorFingerprint(
        'tool-execution', 'get_country_risk', new Error('get-country-risk HTTP 401: invalid_internal_mcp_signature'),
      );
      assert.deepEqual(tenders, ['mcp-internal-auth-401']);
      assert.deepEqual(brief, tenders);
      assert.deepEqual(risk, tenders);
    });

    it('carries no tool or endpoint token that could re-fragment the group', () => {
      const fp = mcpErrorFingerprint(
        'tool-execution', 'get_procurement_opportunities', new Error('list-global-tenders HTTP 401: invalid_internal_mcp_signature'),
      );
      assert.equal(fp.length, 1, `a 401 fingerprint must be a single stable token, got ${fp.join(',')}`);
      assert.ok(
        !fp.some((t) => t.includes('procurement') || t.includes('tenders')),
        'neither the tool nor the endpoint may appear in the 401 fingerprint',
      );
    });

    it('coalesces a 401 across capture steps too', () => {
      const exec = mcpErrorFingerprint('tool-execution', 't', new Error('feed-digest HTTP 401: invalid_internal_mcp_signature'));
      const post = mcpErrorFingerprint('post-filter', 't', new Error('feed-digest HTTP 401: invalid_internal_mcp_signature'));
      assert.deepEqual(exec, post);
    });

    it('leaves neighbouring auth-shaped statuses on the per-tool path', () => {
      // 403 is a real per-endpoint entitlement answer, not the shared hop.
      const forbidden = mcpErrorFingerprint('tool-execution', 't', new Error('feed-digest HTTP 403'));
      assert.deepEqual(forbidden, ['mcp-tool-execution', 't', 'feed-digest:403']);
    });
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
