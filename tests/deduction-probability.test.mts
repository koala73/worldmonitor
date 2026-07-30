import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractDeductionProbability } from '../src/components/deduction-probability';

describe('deduction probability parsing', () => {
  it('preserves rough ranges from primary path headings', () => {
    const parsed = extractDeductionProbability('Most likely path (next 24-72h, 40-55%)');

    assert.deepEqual(parsed, {
      label: '40-55%',
      remainder: 'Most likely path (next 24-72h, 40-55%)',
      isRange: true,
    });
  });

  it('supports single percentages as approximate values', () => {
    const parsed = extractDeductionProbability('Most likely path (next 24-72h, 55%)');

    assert.deepEqual(parsed, {
      label: '~55%',
      remainder: 'Most likely path (next 24-72h, 55%)',
      isRange: false,
    });
  });

  it('extracts leading alternative path ranges without collapsing to one endpoint', () => {
    const parsed = extractDeductionProbability('40-55%: Negotiated pause after shuttle diplomacy', { leadingOnly: true });

    assert.deepEqual(parsed, {
      label: '40-55%',
      remainder: 'Negotiated pause after shuttle diplomacy',
      isRange: true,
    });
  });

  it('supports leading alternative path single percentages', () => {
    const parsed = extractDeductionProbability('35% spillover risk if talks fail', { leadingOnly: true });

    assert.deepEqual(parsed, {
      label: '~35%',
      remainder: 'spillover risk if talks fail',
      isRange: false,
    });
  });

  it('does not badge non-leading alternative path percentages', () => {
    const parsed = extractDeductionProbability('Spillover risk rises toward 35% if talks fail', { leadingOnly: true });

    assert.equal(parsed, null);
  });

  it('does not badge invalid percentage values', () => {
    assert.equal(extractDeductionProbability('Most likely path (125%)'), null);
    assert.equal(extractDeductionProbability('Most likely path (125-90%)'), null);
    assert.equal(extractDeductionProbability('Most likely path (90-40%)'), null);
    assert.equal(extractDeductionProbability('40-125%: impossible range', { leadingOnly: true }), null);
    assert.equal(extractDeductionProbability('125-150%: impossible range', { leadingOnly: true }), null);
  });

  it('skips invalid range endpoints before falling back to a later standalone percentage', () => {
    const parsed = extractDeductionProbability('Most likely path (40-125%, ~50%)');

    assert.deepEqual(parsed, {
      label: '~50%',
      remainder: 'Most likely path (40-125%, ~50%)',
      isRange: false,
    });
  });

  it('uses document order when a single percentage appears before a later range', () => {
    const parsed = extractDeductionProbability('55% likely, escalation case 30-40%');

    assert.deepEqual(parsed, {
      label: '~55%',
      remainder: '55% likely, escalation case 30-40%',
      isRange: false,
    });
  });
});
