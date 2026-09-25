import { afterEach, describe, expect, it } from 'vitest';

import { SignalModal } from '@/components/SignalModal';
import { findReloadBlockingModal, isModalOpen } from '@/utils/open-modal';

afterEach(() => {
  document.body.innerHTML = '';
});

/**
 * WORLDMONITOR-15X / -15Z. SignalModal auto-opens from background correlation
 * and military-surge analysis (`src/app/data-loader.ts:975`) and has no
 * auto-dismiss, so while it counted as reload-blocking it wedged both the
 * stale-bundle check and the service-worker updater for the rest of the
 * session. 150 of 198 production deferrals named `signal-modal-overlay`.
 *
 * The element is read-only on all three open paths: the only control in the
 * component is an in-memory sound toggle that a reload resets anyway. So it
 * holds nothing a reload would destroy, and must not hold a reload off.
 *
 * jsdom loads no stylesheet, so `checkVisibility()` reports the attached
 * element rendered regardless of the `active` class. That makes this the
 * strictest form of the assertion: the element must be excluded by the
 * attribute contract, not by happening to be hidden.
 */
describe('SignalModal reload safety', () => {
  it('does not hold an automatic reload off', () => {
    new SignalModal();
    expect(findReloadBlockingModal(document)).toBe(null);
  });

  it('is still an overlay for the accessibility question', () => {
    new SignalModal();
    expect(isModalOpen(document)).toBe(true);
  });
});
