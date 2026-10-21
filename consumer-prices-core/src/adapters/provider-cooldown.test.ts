import { describe, expect, it } from 'vitest';
import { COOLDOWN_PROBE_INTERVAL, ProviderCooldownGate } from './provider-cooldown.js';

describe('ProviderCooldownGate', () => {
  it('stays closed on a single failure', () => {
    const gate = new ProviderCooldownGate();
    expect(gate.recordFailure()).toBe(false);
    expect(gate.isOpen).toBe(false);
    expect(gate.consumeSkip()).toBe(false);
  });

  it('opens after two consecutive failures and skips exactly probeInterval attempts', () => {
    const gate = new ProviderCooldownGate();
    gate.recordFailure();
    expect(gate.recordFailure()).toBe(true);
    for (let i = 0; i < COOLDOWN_PROBE_INTERVAL; i++) {
      expect(gate.consumeSkip()).toBe(true);
    }
    // Skip window exhausted: the next attempt is the probe.
    expect(gate.consumeSkip()).toBe(false);
  });

  it('closes fully when the probe succeeds, and reports the close', () => {
    const gate = new ProviderCooldownGate(2);
    gate.recordFailure();
    gate.recordFailure();
    gate.consumeSkip();
    gate.consumeSkip();
    expect(gate.consumeSkip()).toBe(false); // probe turn
    // The probe success reports that it closed a cooldown (callers log it);
    // an ordinary success with no pending cooldown reports false.
    expect(gate.recordSuccess()).toBe(true);
    expect(gate.recordSuccess()).toBe(false);
    expect(gate.isOpen).toBe(false);
    expect(gate.consumeSkip()).toBe(false);
    // A later single failure does not immediately reopen.
    expect(gate.recordFailure()).toBe(false);
    expect(gate.consumeSkip()).toBe(false);
  });

  it('re-opens another skip window when the probe fails', () => {
    const gate = new ProviderCooldownGate(2);
    gate.recordFailure();
    expect(gate.recordFailure()).toBe(true); // opens
    gate.consumeSkip();
    gate.consumeSkip();
    expect(gate.consumeSkip()).toBe(false); // probe turn
    expect(gate.recordFailure()).toBe(true); // probe failed -> re-opens
    expect(gate.consumeSkip()).toBe(true);
    expect(gate.consumeSkip()).toBe(true);
    expect(gate.consumeSkip()).toBe(false); // next probe
  });

  it('success resets the failure streak, not just the skip window', () => {
    const gate = new ProviderCooldownGate();
    gate.recordFailure();
    gate.recordSuccess();
    expect(gate.recordFailure()).toBe(false); // streak restarted at 1
    expect(gate.isOpen).toBe(false);
  });
});
