import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTH_SETTLE_GRACE_MS,
  FreeTierGate,
  panelGateStateChanged,
  shouldRunCloudLegacyRecovery,
  sweepLegacyDisabledCustomWidgets,
} from '../src/app/free-tier-gate.ts';

describe('free-tier gate fallback timer', () => {
  it('enforces once the grace period elapses with the session unresolved', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let enforced = 0;
      const gate = new FreeTierGate(() => {
        enforced += 1;
      });

      gate.scheduleFallback();
      assert.equal(gate.fallbackPending, true);
      assert.equal(gate.authSettleDeadlineExceeded, false);

      mock.timers.tick(AUTH_SETTLE_GRACE_MS - 1);
      assert.equal(enforced, 0, 'must not enforce before the grace period ends');

      mock.timers.tick(1);
      assert.equal(enforced, 1, 'must enforce once the grace period ends');
      assert.equal(gate.authSettleDeadlineExceeded, true);
      assert.equal(gate.fallbackPending, false);
    } finally {
      mock.timers.reset();
    }
  });

  it('does not arm a second timer while one is pending', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let enforced = 0;
      const gate = new FreeTierGate(() => {
        enforced += 1;
      });

      gate.scheduleFallback();
      gate.scheduleFallback();
      gate.scheduleFallback();

      mock.timers.tick(AUTH_SETTLE_GRACE_MS);
      assert.equal(enforced, 1, 'repeated deferrals must share one backstop');
    } finally {
      mock.timers.reset();
    }
  });

  it('stays disarmed after the deadline fires', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let enforced = 0;
      const gate = new FreeTierGate(() => {
        enforced += 1;
      });

      gate.scheduleFallback();
      mock.timers.tick(AUTH_SETTLE_GRACE_MS);
      gate.scheduleFallback();
      mock.timers.tick(AUTH_SETTLE_GRACE_MS);

      assert.equal(enforced, 1, 'a sticky deadline must not re-arm the backstop');
      assert.equal(gate.fallbackPending, false);
    } finally {
      mock.timers.reset();
    }
  });

  it('cancels a pending fallback on normal settle or teardown', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let enforced = 0;
      const gate = new FreeTierGate(() => {
        enforced += 1;
      });

      gate.scheduleFallback();
      gate.cancelFallback();
      assert.equal(gate.fallbackPending, false);

      mock.timers.tick(AUTH_SETTLE_GRACE_MS * 2);
      assert.equal(enforced, 0, 'a cancelled backstop must never enforce');
      assert.equal(gate.authSettleDeadlineExceeded, false, 'cancelling must not burn the deadline');

      // A later unresolved window can still arm a fresh backstop.
      gate.scheduleFallback();
      mock.timers.tick(AUTH_SETTLE_GRACE_MS);
      assert.equal(enforced, 1);
    } finally {
      mock.timers.reset();
    }
  });

  it('resets the deadline for a new auth/account window', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let enforced = 0;
      const gate = new FreeTierGate(() => {
        enforced += 1;
      });

      gate.scheduleFallback();
      mock.timers.tick(AUTH_SETTLE_GRACE_MS);
      assert.equal(gate.authSettleDeadlineExceeded, true);

      gate.resetForAuthTransition();
      assert.equal(gate.authSettleDeadlineExceeded, false);
      gate.scheduleFallback();
      mock.timers.tick(AUTH_SETTLE_GRACE_MS);

      assert.equal(enforced, 2, 'a new account must receive a fresh grace period');
    } finally {
      mock.timers.reset();
    }
  });
});

describe('legacy custom-widget recovery sweep', () => {
  const owned = new Set(['cw-owned', 'cw-hidden']);

  it('re-enables owned custom widgets the pre-marker gate disabled', () => {
    const swept = sweepLegacyDisabledCustomWidgets(
      { 'cw-owned': { name: 'Owned', enabled: false, priority: 3 } },
      owned,
    );

    assert.deepEqual(swept['cw-owned'], { name: 'Owned', enabled: true, priority: 3 });
  });

  it('leaves widgets the user no longer owns alone', () => {
    const swept = sweepLegacyDisabledCustomWidgets(
      { 'cw-deleted': { name: 'Deleted', enabled: false, priority: 3 } },
      owned,
    );

    assert.deepEqual(swept['cw-deleted'], { name: 'Deleted', enabled: false, priority: 3 });
  });

  it('never touches non-custom panels or already-enabled ones', () => {
    const original = {
      news: { name: 'News', enabled: false, priority: 1 },
      'cw-owned': { name: 'Owned', enabled: true, priority: 3 },
    };

    const swept = sweepLegacyDisabledCustomWidgets(original, owned);

    assert.deepEqual(swept.news, original.news);
    assert.deepEqual(swept['cw-owned'], original['cw-owned']);
  });

  it('returns a new map without mutating the input', () => {
    const original = { 'cw-owned': { name: 'Owned', enabled: false, priority: 3 } };

    const swept = sweepLegacyDisabledCustomWidgets(original, owned);

    assert.equal(original['cw-owned'].enabled, false, 'input must not be mutated');
    assert.notEqual(swept['cw-owned'], original['cw-owned']);
  });
});

describe('panel gate change detection', () => {
  it('detects an enabled flip', () => {
    assert.equal(
      panelGateStateChanged(
        { news: { name: 'News', enabled: true } },
        { news: { name: 'News', enabled: false } },
      ),
      true,
    );
  });

  it('detects a marker-only strip so stale proGated flags get persisted', () => {
    assert.equal(
      panelGateStateChanged(
        { 'cw-a': { name: 'A', enabled: true, proGated: true } },
        { 'cw-a': { name: 'A', enabled: true } },
      ),
      true,
    );
  });

  it('reports no change when enabled and the marker both match', () => {
    assert.equal(
      panelGateStateChanged(
        { news: { name: 'News', enabled: true }, 'cw-a': { name: 'A', enabled: false, proGated: true } },
        { news: { name: 'News', enabled: true }, 'cw-a': { name: 'A', enabled: false, proGated: true } },
      ),
      false,
    );
  });

  it('detects an added or removed panel entry', () => {
    assert.equal(
      panelGateStateChanged({}, { news: { name: 'News', enabled: true } }),
      true,
    );
  });
});

describe('bounded cloud legacy recovery', () => {
  it('allows the first cloud version after the local baseline', () => {
    assert.equal(shouldRunCloudLegacyRecovery(7, null, 8), true);
  });

  it('does not re-arm after a cloud version was already recovered', () => {
    assert.equal(shouldRunCloudLegacyRecovery(7, 8, 9), false);
  });

  it('does not recover without an incoming cloud version or for the baseline', () => {
    assert.equal(shouldRunCloudLegacyRecovery(7, null, undefined), false);
    assert.equal(shouldRunCloudLegacyRecovery(7, null, 7), false);
    assert.equal(shouldRunCloudLegacyRecovery(7, null, 6), false);
  });
});
