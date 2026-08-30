import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { withScorecardDeadline } from '../src/services/scorecard.ts';

describe('five-factor scorecard service deadline', () => {
  it('does not start a request when the caller signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('caller cancelled', 'AbortError'));
    let calls = 0;

    await assert.rejects(
      withScorecardDeadline(() => {
        calls += 1;
        return Promise.reject(new Error('request must not start'));
      }, controller.signal),
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    );
    assert.equal(calls, 0);
  });

  it('rejects a request whose authentication or transport promise ignores abort', async () => {
    let requestSignal: AbortSignal | null = null;
    const request = withScorecardDeadline((signal) => {
      requestSignal = signal;
      return new Promise<never>(() => {});
    }, undefined, 10);

    await assert.rejects(request, (error: unknown) =>
      error instanceof Error && error.name === 'TimeoutError');
    assert.equal(requestSignal?.aborted, true);
  });

  it('keeps a late response from replacing the deadline result', async () => {
    let resolveLate!: (value: string) => void;
    const request = withScorecardDeadline(() => new Promise<string>((resolve) => {
      resolveLate = resolve;
    }), undefined, 10);

    await assert.rejects(request, (error: unknown) =>
      error instanceof Error && error.name === 'TimeoutError');
    resolveLate('late scorecard');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await assert.rejects(request, (error: unknown) =>
      error instanceof Error && error.name === 'TimeoutError');
  });
});
