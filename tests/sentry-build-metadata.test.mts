import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getSentryBuildMetadata, isolateNonProductionSentryEvent } from '../shared/sentry-build-metadata';

describe('Sentry build attribution', () => {
  it('keeps preview build tags without adding to production release ordering', () => {
    const sha = 'a'.repeat(40);
    const metadata = getSentryBuildMetadata('2.10.0', sha, 'preview');
    assert.equal(metadata.release, undefined);
    assert.equal(metadata.dist, undefined);
    assert.equal(metadata.initialScope?.tags.build_sha, sha);
    assert.equal(metadata.initialScope?.tags.app_version, '2.10.0');
  });

  it('separates preview fingerprints and removes explicitly supplied releases', () => {
    const event = { release: 'a'.repeat(40), dist: 'a'.repeat(40), fingerprint: ['custom-group'] };
    isolateNonProductionSentryEvent(event, 'preview');
    assert.equal(event.release, undefined);
    assert.equal(event.dist, undefined);
    assert.deepEqual(event.fingerprint, ['custom-group', 'worldmonitor:preview']);
    const production = { release: 'b'.repeat(40), fingerprint: ['custom-group'] };
    isolateNonProductionSentryEvent(production, 'production');
    assert.deepEqual(production, { release: 'b'.repeat(40), fingerprint: ['custom-group'] });
  });

  it('uses the deployment SHA as release and keeps version and build attribution', () => {
    const sha = 'aa74d8947a7cd59afef896078a606d31e0bd388b';

    assert.deepEqual(getSentryBuildMetadata('2.10.0', sha), {
      release: sha,
      dist: sha,
      initialScope: {
        tags: {
          build_sha: sha,
          app_version: '2.10.0',
        },
      },
    });
  });

  it('changes release on the next deployment even when the app version is unchanged', () => {
    const first = getSentryBuildMetadata('2.10.0', 'a'.repeat(40));
    const next = getSentryBuildMetadata('2.10.0', 'b'.repeat(40));
    assert.notEqual(first.release, next.release);
  });

  it('omits build attribution for local and malformed build markers', () => {
    for (const buildHash of ['dev', '', 'abc123', 'g'.repeat(40), 'a'.repeat(41)]) {
      assert.deepEqual(
        getSentryBuildMetadata('2.10.0', buildHash),
        { release: 'worldmonitor@2.10.0' },
      );
    }
  });

  it('normalizes surrounding whitespace from the injected SHA', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const metadata = getSentryBuildMetadata('2.10.0', `  ${sha}\n`);

    assert.equal(metadata.dist, sha);
    assert.equal(metadata.release, sha);
    assert.equal(metadata.initialScope?.tags.build_sha, sha);
  });
});
