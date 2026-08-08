import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ACLED_DEFAULT_WINDOW_MS,
  resolveAcledEventWindow,
} from '../server/worldmonitor/conflict/v1/list-acled-events.ts';

describe('ACLED conflict date window', () => {
  it('treats generated zero timestamps as an unset recent window', () => {
    const now = Date.UTC(2026, 5, 12, 12, 0, 0);

    const window = resolveAcledEventWindow({ start: 0, end: 0 }, now);

    assert.equal(window.startMs, now - ACLED_DEFAULT_WINDOW_MS);
    assert.equal(window.endMs, now);
  });

  it('preserves explicit non-zero timestamps', () => {
    const start = Date.UTC(2026, 4, 1, 0, 0, 0);
    const end = Date.UTC(2026, 4, 15, 0, 0, 0);

    const window = resolveAcledEventWindow({ start, end }, Date.UTC(2026, 5, 12, 12, 0, 0));

    assert.equal(window.startMs, start);
    assert.equal(window.endMs, end);
  });
});
