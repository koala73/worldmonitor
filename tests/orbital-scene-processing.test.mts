import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ArchiveFailure } from '../src/services/orbital/archive-result.ts';
import { isSceneStillProcessing, SENTINEL_1_PROCESSING_WINDOW_MS } from '../src/services/orbital/scene-processing.ts';

const NOW = Date.UTC(2026, 10, 16, 6);
const HOUR = 3_600_000;
const notFound: ArchiveFailure = { archive: 'planetary-computer', reason: 'http-status', httpStatus: 404 };
const radar = (hoursAgo: number) => ({ profileId: 'sentinel-1', acquiredMs: NOW - hoursAgo * HOUR });

describe('isSceneStillProcessing', () => {
  it('reads a 404 for a Sentinel-1 scene acquired within the window as processing', () => {
    assert.equal(isSceneStillProcessing(notFound, radar(3), NOW), true);
    assert.equal(isSceneStillProcessing(notFound, { profileId: 'sentinel-1', acquiredMs: NOW - SENTINEL_1_PROCESSING_WINDOW_MS + 1 }, NOW), true);
  });

  it('keeps a 404 for a Sentinel-1 scene older than the window a failure', () => {
    assert.equal(SENTINEL_1_PROCESSING_WINDOW_MS, 24 * HOUR);
    assert.equal(isSceneStillProcessing(notFound, { profileId: 'sentinel-1', acquiredMs: NOW - SENTINEL_1_PROCESSING_WINDOW_MS }, NOW), false);
    assert.equal(isSceneStillProcessing(notFound, radar(72), NOW), false);
  });

  it('keeps every other failure of a fresh Sentinel-1 scene a failure', () => {
    for (const failure of [
      { archive: 'planetary-computer', reason: 'http-status', httpStatus: 500 },
      { archive: 'planetary-computer', reason: 'http-status', httpStatus: 403 },
      { archive: 'planetary-computer', reason: 'network' },
      { archive: 'planetary-computer', reason: 'timeout' },
      { archive: 'planetary-computer', reason: 'invalid-response' },
      { archive: 'earth-search', reason: 'http-status', httpStatus: 404 },
    ] satisfies ArchiveFailure[]) {
      assert.equal(isSceneStillProcessing(failure, radar(3), NOW), false, JSON.stringify(failure));
    }
    assert.equal(isSceneStillProcessing(null, radar(3), NOW), false);
  });

  it('keeps a fresh 404 for any other mission a failure', () => {
    for (const profileId of ['sentinel-2', 'landsat', 'MODIS_Terra_CorrectedReflectance_TrueColor']) {
      assert.equal(isSceneStillProcessing(notFound, { profileId, acquiredMs: NOW - 3 * HOUR }, NOW), false, profileId);
    }
  });

  it('keeps a scene with no readable acquisition time a failure', () => {
    assert.equal(isSceneStillProcessing(notFound, { profileId: 'sentinel-1', acquiredMs: Number.NaN }, NOW), false);
  });
});
