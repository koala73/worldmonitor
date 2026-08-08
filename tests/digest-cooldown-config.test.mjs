// Sprint 1 / U5 — kill-switch parser tests for the cooldown decision
// module. The parser is the gate between operator intent
// (`DIGEST_COOLDOWN_MODE` env) and the runtime "should we evaluate
// cooldown for this send?" decision. Every code path must fail closed
// to 'shadow' on anything we don't recognise — per
// feedback_kill_switch_default_on_typo, a typo that produces an
// unintended-enforce shape is worse than no signal at all.
//
// Sprint 1 deliberately rejects 'enforce' (Sprint 2 introduces it),
// so the parser MUST treat 'enforce' as a typo-class invalid value
// and fall back to 'shadow' with the invalidRaw warn surface.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  readCooldownConfig,
  readCooldownMode,
} from '../scripts/lib/digest-cooldown-config.mjs';

describe('readCooldownConfig — default + valid modes', () => {
  it('empty env → mode=shadow (the safe default), invalidRaw=null', () => {
    const cfg = readCooldownConfig({});
    assert.equal(cfg.mode, 'shadow');
    assert.equal(cfg.invalidRaw, null);
  });

  it('undefined value → mode=shadow, invalidRaw=null', () => {
    const cfg = readCooldownConfig({ DIGEST_COOLDOWN_MODE: undefined });
    assert.equal(cfg.mode, 'shadow');
    assert.equal(cfg.invalidRaw, null);
  });

  it('empty string → mode=shadow (Railway dashboard widget produces empty for "no operator opinion")', () => {
    const cfg = readCooldownConfig({ DIGEST_COOLDOWN_MODE: '' });
    assert.equal(cfg.mode, 'shadow');
    assert.equal(cfg.invalidRaw, null);
  });

  it('whitespace-only string → mode=shadow (treated as unset after trim)', () => {
    const cfg = readCooldownConfig({ DIGEST_COOLDOWN_MODE: '   \t  ' });
    assert.equal(cfg.mode, 'shadow');
    assert.equal(cfg.invalidRaw, null);
  });

  it('exact "shadow" → mode=shadow, invalidRaw=null', () => {
    const cfg = readCooldownConfig({ DIGEST_COOLDOWN_MODE: 'shadow' });
    assert.equal(cfg.mode, 'shadow');
    assert.equal(cfg.invalidRaw, null);
  });

  it('exact "off" → mode=off, invalidRaw=null', () => {
    const cfg = readCooldownConfig({ DIGEST_COOLDOWN_MODE: 'off' });
    assert.equal(cfg.mode, 'off');
    assert.equal(cfg.invalidRaw, null);
  });
});

describe('readCooldownConfig — case-folding (operator typing)', () => {
  it('"Shadow" → mode=shadow (operators paste mixed-case during incidents)', () => {
    const cfg = readCooldownConfig({ DIGEST_COOLDOWN_MODE: 'Shadow' });
    assert.equal(cfg.mode, 'shadow');
    assert.equal(cfg.invalidRaw, null);
  });

  it('"OFF" → mode=off (uppercase is a common Railway dashboard pattern)', () => {
    const cfg = readCooldownConfig({ DIGEST_COOLDOWN_MODE: 'OFF' });
    assert.equal(cfg.mode, 'off');
    assert.equal(cfg.invalidRaw, null);
  });

  it('"Off" → mode=off (mixed case still resolves)', () => {
    const cfg = readCooldownConfig({ DIGEST_COOLDOWN_MODE: 'Off' });
    assert.equal(cfg.mode, 'off');
    assert.equal(cfg.invalidRaw, null);
  });

  it('leading/trailing whitespace is trimmed before classification', () => {
    const cfg = readCooldownConfig({ DIGEST_COOLDOWN_MODE: '  shadow  ' });
    assert.equal(cfg.mode, 'shadow');
    assert.equal(cfg.invalidRaw, null);
  });
});

describe('readCooldownConfig — fail-closed-to-shadow on typo / invalid', () => {
  it('"enforce" → mode=shadow + invalidRaw="enforce" (intentionally invalid in Sprint 1)', () => {
    // The point: an operator who flips DIGEST_COOLDOWN_MODE=enforce
    // before Sprint 2 ships gets fail-closed-to-shadow + a loud warn
    // surface, NOT a silent partial-enforce state.
    const cfg = readCooldownConfig({ DIGEST_COOLDOWN_MODE: 'enforce' });
    assert.equal(cfg.mode, 'shadow');
    assert.equal(cfg.invalidRaw, 'enforce');
  });

  it('"true" → mode=shadow + invalidRaw="true" (boolean-coercion mistake)', () => {
    const cfg = readCooldownConfig({ DIGEST_COOLDOWN_MODE: 'true' });
    assert.equal(cfg.mode, 'shadow');
    assert.equal(cfg.invalidRaw, 'true');
  });

  it('"1" → mode=shadow + invalidRaw="1" (numeric-coercion mistake)', () => {
    const cfg = readCooldownConfig({ DIGEST_COOLDOWN_MODE: '1' });
    assert.equal(cfg.mode, 'shadow');
    assert.equal(cfg.invalidRaw, '1');
  });

  it('"garbage" → mode=shadow + invalidRaw="garbage" (generic typo)', () => {
    const cfg = readCooldownConfig({ DIGEST_COOLDOWN_MODE: 'garbage' });
    assert.equal(cfg.mode, 'shadow');
    assert.equal(cfg.invalidRaw, 'garbage');
  });

  it('case-folded typo: "ENFORCE" → mode=shadow + invalidRaw="enforce" (post-fold)', () => {
    // The invalidRaw is post-fold lowercase — operators chasing a typo
    // care about which value the parser saw, not the exact capitalisation.
    const cfg = readCooldownConfig({ DIGEST_COOLDOWN_MODE: 'ENFORCE' });
    assert.equal(cfg.mode, 'shadow');
    assert.equal(cfg.invalidRaw, 'enforce');
  });
});

describe('readCooldownMode — convenience accessor', () => {
  it('returns just the mode (no invalidRaw)', () => {
    assert.equal(readCooldownMode({}), 'shadow');
    assert.equal(readCooldownMode({ DIGEST_COOLDOWN_MODE: 'off' }), 'off');
    assert.equal(readCooldownMode({ DIGEST_COOLDOWN_MODE: 'enforce' }), 'shadow');
  });

  it('defaults env to process.env when unspecified', () => {
    // Snapshot + restore so we don't pollute the rest of the suite.
    const original = process.env.DIGEST_COOLDOWN_MODE;
    try {
      process.env.DIGEST_COOLDOWN_MODE = 'off';
      assert.equal(readCooldownMode(), 'off');
    } finally {
      if (original === undefined) delete process.env.DIGEST_COOLDOWN_MODE;
      else process.env.DIGEST_COOLDOWN_MODE = original;
    }
  });
});

describe('readCooldownConfig — purity contract', () => {
  it('does not mutate the input env', () => {
    const env = Object.freeze({ DIGEST_COOLDOWN_MODE: 'enforce' });
    // assert.doesNotThrow because Object.freeze would throw on any
    // mutation attempt — proving the parser is read-only.
    assert.doesNotThrow(() => readCooldownConfig(env));
  });

  it('returns the same shape for the same input (deterministic)', () => {
    const a = readCooldownConfig({ DIGEST_COOLDOWN_MODE: 'enforce' });
    const b = readCooldownConfig({ DIGEST_COOLDOWN_MODE: 'enforce' });
    assert.deepEqual(a, b);
  });
});
