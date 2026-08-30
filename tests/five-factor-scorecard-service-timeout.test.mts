import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SCORECARD_REQUEST_TIMEOUT_MS, withScorecardDeadline } from '../src/services/scorecard.ts';
import {
  SCORECARD_ENTITLEMENT_ALLOWANCE_MS,
  SCORECARD_READ_DEADLINE_MS,
} from '../server/worldmonitor/scorecard/v1/_read-snapshot.ts';

describe('five-factor scorecard service deadline', () => {
  it('gives the client more budget than the server can serially spend', () => {
    // The entitlement check runs in createDomainGateway BEFORE the handler
    // starts its own read deadline, so the two server costs are SERIAL. At the
    // previous 8s the client aborted first and a Redis degradation surfaced as
    // a cancelled request instead of the designed unavailable card.
    const serverWorstCaseMs = SCORECARD_ENTITLEMENT_ALLOWANCE_MS + SCORECARD_READ_DEADLINE_MS;
    assert.ok(
      SCORECARD_REQUEST_TIMEOUT_MS > serverWorstCaseMs,
      `client budget ${SCORECARD_REQUEST_TIMEOUT_MS}ms must exceed the server's serial worst case ${serverWorstCaseMs}ms`,
    );
    // And leave room for serialization, cold start and the round trip on top.
    assert.ok(
      SCORECARD_REQUEST_TIMEOUT_MS - serverWorstCaseMs >= 1_000,
      'client budget must leave at least 1s for serialization and transfer',
    );
  });

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
