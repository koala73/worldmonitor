import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import {
  deriveShortageEvidenceQuality,
  countEvidenceSources,
  SHORTAGE_EVIDENCE_VERSION,
  type ShortageEvidenceInput,
} from '../src/shared/shortage-evidence';

const NOW = Date.parse('2026-04-22T00:00:00Z');

describe('deriveShortageEvidenceQuality', () => {
  test('null / empty input returns "thin"', () => {
    assert.equal(deriveShortageEvidenceQuality(undefined, NOW), 'thin');
    assert.equal(deriveShortageEvidenceQuality(null, NOW), 'thin');
    assert.equal(deriveShortageEvidenceQuality({}, NOW), 'thin');
  });

  test('high confidence + regulator source + fresh → "strong"', () => {
    const ev: ShortageEvidenceInput = {
      classifierConfidence: 0.9,
      evidenceSources: [{ sourceType: 'regulator' }],
      lastEvidenceUpdate: '2026-04-18T00:00:00Z',
    };
    assert.equal(deriveShortageEvidenceQuality(ev, NOW), 'strong');
  });

  test('moderate confidence + operator source + fresh → "moderate"', () => {
    const ev: ShortageEvidenceInput = {
      classifierConfidence: 0.75,
      evidenceSources: [{ sourceType: 'operator' }],
      lastEvidenceUpdate: '2026-04-18T00:00:00Z',
    };
    assert.equal(deriveShortageEvidenceQuality(ev, NOW), 'moderate');
  });

  test('press-only evidence → "thin" regardless of confidence', () => {
    const ev: ShortageEvidenceInput = {
      classifierConfidence: 0.95,
      evidenceSources: [{ sourceType: 'press' }, { sourceType: 'press' }],
      lastEvidenceUpdate: '2026-04-18T00:00:00Z',
    };
    assert.equal(deriveShortageEvidenceQuality(ev, NOW), 'thin');
  });

  test('stale evidence demotes strong → thin', () => {
    const ev: ShortageEvidenceInput = {
      classifierConfidence: 0.95,
      evidenceSources: [{ sourceType: 'regulator' }],
      lastEvidenceUpdate: '2026-01-01T00:00:00Z',
    };
    assert.equal(deriveShortageEvidenceQuality(ev, NOW), 'thin');
  });

  test('low confidence floor → "thin"', () => {
    const ev: ShortageEvidenceInput = {
      classifierConfidence: 0.5,
      evidenceSources: [{ sourceType: 'regulator' }],
      lastEvidenceUpdate: '2026-04-18T00:00:00Z',
    };
    assert.equal(deriveShortageEvidenceQuality(ev, NOW), 'thin');
  });

  test('version string is stable for v1', () => {
    assert.equal(SHORTAGE_EVIDENCE_VERSION, 'shortage-evidence-v1');
  });

  test('never throws on malformed input', () => {
    assert.doesNotThrow(() => deriveShortageEvidenceQuality({ evidenceSources: [null as any] }, NOW));
    assert.doesNotThrow(() => deriveShortageEvidenceQuality({ classifierConfidence: Number.NaN }, NOW));
  });
});

describe('countEvidenceSources', () => {
  test('null / undefined returns all zeros', () => {
    assert.deepEqual(countEvidenceSources(null), { authoritative: 0, press: 0, other: 0 });
    assert.deepEqual(countEvidenceSources(undefined), { authoritative: 0, press: 0, other: 0 });
  });

  test('mixed sources bucket correctly', () => {
    const result = countEvidenceSources([
      { sourceType: 'regulator' },
      { sourceType: 'operator' },
      { sourceType: 'press' },
      { sourceType: 'press' },
      { sourceType: 'satellite' },
    ]);
    assert.deepEqual(result, { authoritative: 2, press: 2, other: 1 });
  });
});
