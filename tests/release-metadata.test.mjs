import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReleaseName,
  buildReleaseTag,
  getReleaseProductName,
  parseReleaseRef,
  parseReleaseTag,
} from '../scripts/release-metadata.mjs';

test('release metadata derives tags and names for every supported variant', () => {
  assert.equal(buildReleaseTag('2.7.2', 'full'), 'v2.7.2');
  assert.equal(buildReleaseTag('2.7.2', 'tech'), 'v2.7.2-tech');
  assert.equal(buildReleaseTag('2.7.2', 'finance'), 'v2.7.2-finance');
  assert.equal(buildReleaseName('2.7.2', 'full'), 'World Monitor v2.7.2');
  assert.equal(buildReleaseName('2.7.2', 'tech'), 'Tech Monitor v2.7.2');
  assert.equal(getReleaseProductName('finance'), 'Finance Monitor');
});

test('release metadata parses tags and refs back into version and variant', () => {
  assert.deepEqual(parseReleaseTag('v2.7.2-finance'), {
    tag: 'v2.7.2-finance',
    version: '2.7.2',
    variant: 'finance',
  });
  assert.deepEqual(parseReleaseRef('refs/tags/v2.7.2'), {
    tag: 'v2.7.2',
    version: '2.7.2',
    variant: 'full',
  });
});
