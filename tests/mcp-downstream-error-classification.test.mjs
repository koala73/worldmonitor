// Unit tests for api/mcp/downstream.ts error-classification helpers
// — classifyFailureReason, formatErrorDetail, BothSourcesFailedError,
// and downstreamErrorTags BothSourcesFailedError handling.
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  classifyFailureReason,
  BothSourcesFailedError,
  downstreamErrorTags,
} from '../api/mcp/downstream.ts';

describe('classifyFailureReason', () => {
  it('returns "timeout" for AbortError', () => {
    const err = new DOMException('The operation was aborted', 'AbortError');
    assert.equal(classifyFailureReason(err), 'timeout');
  });

  it('returns "timeout" for TimeoutError', () => {
    const err = new Error('timed out');
    err.name = 'TimeoutError';
    assert.equal(classifyFailureReason(err), 'timeout');
  });

  it('returns "http_{status}" for HTTP status messages', () => {
    assert.equal(classifyFailureReason(new Error('HTTP 500')), 'http_500');
    assert.equal(classifyFailureReason(new Error('HTTP 404')), 'http_404');
    assert.equal(classifyFailureReason(new Error('HTTP 503 Backend')), 'http_503');
  });

  it('returns "auth_error" for auth-related messages', () => {
    assert.equal(classifyFailureReason(new Error('unauthorized')), 'auth_error');
    assert.equal(classifyFailureReason(new Error('forbidden')), 'auth_error');
    assert.equal(classifyFailureReason(new Error('invalid auth token')), 'auth_error');
    assert.equal(classifyFailureReason(new Error('secret not found')), 'auth_error');
    assert.equal(classifyFailureReason(new Error('API key rejected')), 'auth_error');
  });

  it('does NOT match substrings for auth keywords', () => {
    // Word boundary anchors prevent false positives
    assert.equal(classifyFailureReason(new Error('monkey')), 'error');
    assert.equal(classifyFailureReason(new Error('monkey wrench')), 'error');
  });

  it('returns "error" for generic errors', () => {
    assert.equal(classifyFailureReason(new Error('something broke')), 'error');
    assert.equal(classifyFailureReason(new TypeError('bad type')), 'error');
  });

  it('returns "unknown" for null/undefined', () => {
    assert.equal(classifyFailureReason(null), 'unknown');
    assert.equal(classifyFailureReason(undefined), 'unknown');
  });

  it('returns stringified value for non-Error rejections', () => {
    assert.equal(classifyFailureReason('just a string'), 'just a string');
    assert.equal(classifyFailureReason(42), '42');
  });
});

describe('BothSourcesFailedError', () => {
  it('carries classified failure reasons from Error rejection reasons', () => {
    const err = new BothSourcesFailedError(
      new Error('HTTP 500'),
      Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
    );
    assert.equal(err.civilianFailure, 'http_500');
    assert.equal(err.militaryFailure, 'timeout');
    assert.equal(err.civilianFailureDetail, 'HTTP 500');
    assert.equal(err.militaryFailureDetail, 'timed out');
    assert.equal(err.message, 'Airspace data unavailable: both civilian and military sources failed');
    assert.equal(err.name, 'BothSourcesFailedError');
  });

  it('carries classified failure reasons from non-Error rejections', () => {
    const err = new BothSourcesFailedError(null, 'auth_error_string');
    assert.equal(err.civilianFailure, 'unknown');
    assert.equal(err.militaryFailure, 'auth_error_string');
    assert.equal(err.civilianFailureDetail, 'null');
    assert.equal(err.militaryFailureDetail, 'auth_error_string');
  });

  it('distinguishes same failure (shared-host outage) from different failures', () => {
    const same = new BothSourcesFailedError(
      new Error('HTTP 500'),
      new Error('HTTP 500'),
    );
    const diff = new BothSourcesFailedError(
      new Error('HTTP 500'),
      new Error('timeout'),
    );
    assert.equal(same.civilianFailure, same.militaryFailure);
    assert.notEqual(diff.civilianFailure, diff.militaryFailure);
  });
});

describe('downstreamErrorTags with BothSourcesFailedError', () => {
  it('returns civilian_failure and military_failure tags', () => {
    const err = new BothSourcesFailedError(
      new Error('HTTP 502'),
      Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
    );
    const tags = downstreamErrorTags(err);
    assert.equal(tags.civilian_failure, 'http_502');
    assert.equal(tags.military_failure, 'timeout');
  });

  it('does not include other error-class fields', () => {
    const err = new BothSourcesFailedError(null, null);
    const tags = downstreamErrorTags(err);
    assert.equal(Object.keys(tags).length, 2);
    assert.equal(tags.civilian_failure, 'unknown');
    assert.equal(tags.military_failure, 'unknown');
  });
});
