import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getSentryBuildMetadata } from '../src/bootstrap/sentry-build-metadata';

describe('Sentry build attribution', () => {
  it('uses the Vercel commit SHA as dist and build_sha without changing release grouping', () => {
    const sha = 'aa74d8947a7cd59afef896078a606d31e0bd388b';

    assert.deepEqual(getSentryBuildMetadata('2.10.0', sha), {
      release: 'worldmonitor@2.10.0',
      dist: sha,
      initialScope: {
        tags: {
          build_sha: sha,
        },
      },
    });
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
    assert.equal(metadata.initialScope?.tags.build_sha, sha);
  });
});
