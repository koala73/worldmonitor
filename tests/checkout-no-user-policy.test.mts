import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideNoUserPathOutcome, runNoUserPath } from '../src/services/checkout-no-user-policy.ts';

describe('decideNoUserPathOutcome', () => {
  it('default (fallbackToPricingPage=true) returns redirect-pro with persist=false', () => {
    const outcome = decideNoUserPathOutcome(true);
    assert.equal(outcome.kind, 'redirect-pro');
    assert.equal(outcome.persist, false);
    if (outcome.kind === 'redirect-pro') {
      assert.equal(outcome.redirectUrl, 'https://worldmonitor.app/pro');
    }
  });

  it('explicit opt-out (fallbackToPricingPage=false) returns inline-signin with persist=true', () => {
    const outcome = decideNoUserPathOutcome(false);
    assert.equal(outcome.kind, 'inline-signin');
    assert.equal(outcome.persist, true);
  });
});

describe('runNoUserPath effect sequencing', () => {
  function record(fallbackToPricingPage: boolean): string[] {
    const log: string[] = [];
    runNoUserPath(fallbackToPricingPage, {
      navigate: (url) => log.push(`navigate:${url}`),
      persistIntent: () => log.push('persistIntent'),
      persistAttempt: () => log.push('persistAttempt'),
      openSignIn: () => log.push('openSignIn'),
    });
    return log;
  }

  it('redirect path navigates and performs NO persistence at all', () => {
    assert.deepEqual(record(true), ['navigate:https://worldmonitor.app/pro']);
  });

  it('inline path persists intent AND attempt BEFORE opening sign-in', () => {
    assert.deepEqual(record(false), ['persistIntent', 'persistAttempt', 'openSignIn']);
  });

  it('inline path never navigates away from the dashboard', () => {
    assert.ok(!record(false).some((entry) => entry.startsWith('navigate:')));
  });
});
