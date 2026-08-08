import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveConfirmLabels } from '../src/components/confirm-dialog-labels.ts';

const FALLBACK = { confirm: 'Discard', cancel: 'Cancel' };

describe('resolveConfirmLabels (#4559 U1)', () => {
  it('uses provided labels when present (happy path)', () => {
    const r = resolveConfirmLabels(
      { message: 'Drop changes?', confirmLabel: 'Drop', cancelLabel: 'Keep' },
      FALLBACK,
    );
    assert.deepEqual(r, { message: 'Drop changes?', confirmLabel: 'Drop', cancelLabel: 'Keep' });
  });

  it('falls back to defaults when labels are omitted', () => {
    const r = resolveConfirmLabels({ message: 'Discard them?' }, FALLBACK);
    assert.equal(r.message, 'Discard them?');
    assert.equal(r.confirmLabel, 'Discard');
    assert.equal(r.cancelLabel, 'Cancel');
  });

  it('treats blank/whitespace labels as missing (edge case)', () => {
    const r = resolveConfirmLabels({ message: 'x', confirmLabel: '', cancelLabel: '   ' }, FALLBACK);
    assert.equal(r.confirmLabel, 'Discard');
    assert.equal(r.cancelLabel, 'Cancel');
  });

  it('passes the message through verbatim', () => {
    const r = resolveConfirmLabels({ message: 'You have unsaved panel changes. Discard them?' }, FALLBACK);
    assert.equal(r.message, 'You have unsaved panel changes. Discard them?');
  });
});
