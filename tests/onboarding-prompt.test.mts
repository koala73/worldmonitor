/**
 * The one-prompt-per-visit decision for the About-you card (KTD6, R4, R5, R19)
 * and the activation decision channel the card waits on.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideAboutYouPrompt,
  reportActivationPromptDecision,
  waitForActivationPromptDecision,
  _resetActivationPromptDecisionForTests,
  type AboutYouPromptInput,
} from '../src/services/onboarding-prompt.ts';

const DUE = { status: 'due', answers: {}, keyQuestionsComplete: false, returnDue: false } as const;

function input(overrides: Partial<AboutYouPromptInput> = {}): AboutYouPromptInput {
  return {
    signedIn: true,
    status: DUE,
    activation: 'not-due',
    missionPickerDue: false,
    modalOpen: false,
    ...overrides,
  };
}

describe('decideAboutYouPrompt', () => {
  it('AE1: a brand-new desktop visitor gets the mission picker, not the card', () => {
    assert.deepEqual(decideAboutYouPrompt(input({ missionPickerDue: true })), { kind: 'none' });
  });

  it('a visitor with a mission chosen and a due profile gets the full card', () => {
    assert.deepEqual(decideAboutYouPrompt(input()), {
      kind: 'about-you',
      mode: 'full',
      questions: ['primaryUse', 'usageContext', 'payer', 'role', 'alternative'],
    });
  });

  it('AE2: a skipped profile gets no card', () => {
    assert.deepEqual(
      decideAboutYouPrompt(input({ status: { ...DUE, status: 'skipped' } })),
      { kind: 'none' },
    );
  });

  it('an answered profile with complete key questions gets no card', () => {
    assert.deepEqual(
      decideAboutYouPrompt(
        input({ status: { status: 'answered', answers: { primaryUse: 'news', usageContext: 'work' }, keyQuestionsComplete: true, returnDue: false } }),
      ),
      { kind: 'none' },
    );
  });

  it('signed out, or the status could not be read: no card', () => {
    assert.deepEqual(decideAboutYouPrompt(input({ signedIn: false })), { kind: 'none' });
    assert.deepEqual(decideAboutYouPrompt(input({ status: null })), { kind: 'none' });
  });

  it('activation will open, or its decision is unknown: no card', () => {
    assert.deepEqual(decideAboutYouPrompt(input({ activation: 'will-open' })), { kind: 'none' });
    assert.deepEqual(decideAboutYouPrompt(input({ activation: 'unknown' })), { kind: 'none' });
  });

  it('a modal is open: no card', () => {
    assert.deepEqual(decideAboutYouPrompt(input({ modalOpen: true })), { kind: 'none' });
  });

  it('R19: the return visit asks only the empty key questions', () => {
    const status = {
      status: 'answered',
      answers: { primaryUse: 'markets' },
      keyQuestionsComplete: false,
      returnDue: true,
    } as const;
    assert.deepEqual(decideAboutYouPrompt(input({ status })), {
      kind: 'about-you',
      mode: 'return',
      questions: ['usageContext'],
    });
    assert.deepEqual(decideAboutYouPrompt(input({ status: { ...status, returnDue: false } })), {
      kind: 'none',
    });
  });
});

describe('activation prompt decision channel', () => {
  afterEach(() => _resetActivationPromptDecisionForTests());

  it('resolves with a decision reported before the wait', async () => {
    reportActivationPromptDecision('not-due');
    assert.equal(await waitForActivationPromptDecision(50), 'not-due');
  });

  it('resolves with a decision reported during the wait', async () => {
    const pending = waitForActivationPromptDecision(1000);
    setTimeout(() => reportActivationPromptDecision('will-open'), 5);
    assert.equal(await pending, 'will-open');
  });

  it('resolves unknown when nothing is reported in time', async () => {
    assert.equal(await waitForActivationPromptDecision(10), 'unknown');
  });

  it('a later report replaces an earlier one', async () => {
    reportActivationPromptDecision('not-due');
    reportActivationPromptDecision('will-open');
    assert.equal(await waitForActivationPromptDecision(10), 'will-open');
  });
});
