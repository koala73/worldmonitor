import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  __testing__,
  getLlmModelHealthStatus,
  isModelRejection,
  isModelUsable,
  recordModelFailure,
  recordModelSuccess,
} from '../server/_shared/llm-health.ts';

const { MODEL_FAILURE_THRESHOLD, MODEL_QUARANTINE_MS } = __testing__;

const OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions';
const GROQ = 'https://api.groq.com/openai/v1/chat/completions';
const DEAD_MODEL = 'ghost/ghost-model-v9';

/** Real provider bodies for an unroutable model ID, verbatim in shape. */
const OPENROUTER_UNKNOWN_MODEL = JSON.stringify({
  error: { message: `${DEAD_MODEL} is not a valid model ID`, code: 400 },
});
const OPENAI_STYLE_UNKNOWN_MODEL = JSON.stringify({
  error: { message: `The model \`${DEAD_MODEL}\` does not exist or you do not have access to it.`, type: 'invalid_request_error' },
});
const OLLAMA_UNKNOWN_MODEL = JSON.stringify({ error: `model '${DEAD_MODEL}' not found, try pulling it first` });

const originalDateNow = Date.now;

afterEach(() => {
  Date.now = originalDateNow;
  __testing__.reset();
});

describe('isModelRejection', () => {
  it('recognises the unknown-model bodies real providers return', () => {
    assert.equal(isModelRejection(400, OPENROUTER_UNKNOWN_MODEL, DEAD_MODEL), true);
    assert.equal(isModelRejection(404, OPENAI_STYLE_UNKNOWN_MODEL, DEAD_MODEL), true);
    assert.equal(isModelRejection(404, OLLAMA_UNKNOWN_MODEL, DEAD_MODEL), true);
    assert.equal(isModelRejection(400, '{"error":{"message":"No such model: foo/bar"}}', 'foo/bar'), true);
  });

  it('recognises plain-text and top-level JSON rejection messages', () => {
    assert.equal(isModelRejection(404, `model '${DEAD_MODEL}' not found`, DEAD_MODEL), true);
    assert.equal(
      isModelRejection(400, JSON.stringify({ message: `${DEAD_MODEL} is not a valid model ID` }), DEAD_MODEL),
      true,
    );
  });

  it('ignores statuses that describe the provider rather than the model', () => {
    // Same body, different status — auth, rate limiting and outages are
    // provider-wide and transient, and say nothing about the model ID.
    for (const status of [401, 403, 429, 500, 502, 503]) {
      assert.equal(
        isModelRejection(status, OPENROUTER_UNKNOWN_MODEL, DEAD_MODEL),
        false,
        `HTTP ${status} must never quarantine a model`,
      );
    }
  });

  it('ignores 4xx bodies that are about the request, not the model', () => {
    assert.equal(isModelRejection(400, '{"error":{"message":"max_tokens is too large"}}', DEAD_MODEL), false);
    assert.equal(isModelRejection(400, '{"error":{"message":"messages: field required"}}', DEAD_MODEL), false);
    assert.equal(isModelRejection(404, 'Not Found', DEAD_MODEL), false);
  });

  it('ignores an unknown-model message that names a different model', () => {
    assert.equal(
      isModelRejection(400, '{"error":{"message":"other/provider-model is not a valid model ID"}}', DEAD_MODEL),
      false,
      'a provider response about another model must not quarantine the configured model',
    );
  });

  it('does not associate request metadata with an error about another model', () => {
    assert.equal(
      isModelRejection(400, JSON.stringify({
        model: DEAD_MODEL,
        error: { message: 'other/provider-model is not a valid model ID' },
      }), DEAD_MODEL),
      false,
      'only the provider error message identifies the rejected model',
    );
  });

  it('requires an exact model ID rather than a longer model with the same prefix', () => {
    assert.equal(
      isModelRejection(400, JSON.stringify({
        error: { message: `${DEAD_MODEL}-v2 is not a valid model ID` },
      }), DEAD_MODEL),
      false,
    );
  });

  it('escapes regex metacharacters in configured model IDs', () => {
    const dottedModel = 'provider/model.v1';
    assert.equal(
      isModelRejection(400, `${dottedModel} is not a valid model ID`, dottedModel),
      true,
    );
    assert.equal(
      isModelRejection(400, 'provider/modelXv1 is not a valid model ID', dottedModel),
      false,
    );
  });

  it('ignores operation-specific unsupported errors for an otherwise valid model', () => {
    assert.equal(
      isModelRejection(400, `{"error":{"message":"The model ${DEAD_MODEL} is not supported for response_format"}}`, DEAD_MODEL),
      false,
      'unsupported request features do not prove the model is unavailable',
    );
  });

  it('treats an unreadable body as non-conclusive', () => {
    // readBoundedErrorBody() resolves to '' when the body cannot be read. The
    // fail-safe is the pre-existing behaviour, not a wrongly-quarantined model.
    assert.equal(isModelRejection(400, '', DEAD_MODEL), false);
  });
});

describe('model quarantine', () => {
  it('keeps a model usable until the consecutive-failure threshold is reached', () => {
    assert.equal(isModelUsable(OPENROUTER, DEAD_MODEL), true);

    for (let i = 1; i < MODEL_FAILURE_THRESHOLD; i += 1) {
      recordModelFailure(OPENROUTER, DEAD_MODEL, 400, OPENROUTER_UNKNOWN_MODEL);
      assert.equal(
        isModelUsable(OPENROUTER, DEAD_MODEL),
        true,
        `${i} rejection(s) is below the threshold and must not quarantine`,
      );
    }

    recordModelFailure(OPENROUTER, DEAD_MODEL, 400, OPENROUTER_UNKNOWN_MODEL);
    assert.equal(isModelUsable(OPENROUTER, DEAD_MODEL), false);
  });

  it('never quarantines on failures that are not model rejections', () => {
    for (let i = 0; i < MODEL_FAILURE_THRESHOLD * 3; i += 1) {
      recordModelFailure(OPENROUTER, DEAD_MODEL, 429, 'rate limit exceeded');
      recordModelFailure(OPENROUTER, DEAD_MODEL, 503, 'upstream error');
      recordModelFailure(OPENROUTER, DEAD_MODEL, 400, '{"error":{"message":"max_tokens is too large"}}');
    }
    assert.equal(isModelUsable(OPENROUTER, DEAD_MODEL), true);
    assert.deepEqual(getLlmModelHealthStatus(), {});
  });

  it('counts CONSECUTIVE rejections — a success clears the record', () => {
    recordModelFailure(OPENROUTER, DEAD_MODEL, 400, OPENROUTER_UNKNOWN_MODEL);
    recordModelSuccess(OPENROUTER, DEAD_MODEL);
    recordModelFailure(OPENROUTER, DEAD_MODEL, 400, OPENROUTER_UNKNOWN_MODEL);

    assert.equal(
      isModelUsable(OPENROUTER, DEAD_MODEL),
      true,
      'the success reset the counter, so this is failure 1 of the budget again',
    );
  });

  it('releases the quarantine once it elapses, with a fresh failure budget', () => {
    for (let i = 0; i < MODEL_FAILURE_THRESHOLD; i += 1) {
      recordModelFailure(OPENROUTER, DEAD_MODEL, 400, OPENROUTER_UNKNOWN_MODEL);
    }
    assert.equal(isModelUsable(OPENROUTER, DEAD_MODEL), false);

    const start = originalDateNow();
    Date.now = () => start + MODEL_QUARANTINE_MS + 1;

    assert.equal(isModelUsable(OPENROUTER, DEAD_MODEL), true, 'a re-listed model must get another chance');

    // The failure count went with it: one rejection must not re-quarantine.
    recordModelFailure(OPENROUTER, DEAD_MODEL, 400, OPENROUTER_UNKNOWN_MODEL);
    assert.equal(isModelUsable(OPENROUTER, DEAD_MODEL), true);
  });

  it('forgets a lone rejection once the failure window passes', () => {
    recordModelFailure(OPENROUTER, DEAD_MODEL, 400, OPENROUTER_UNKNOWN_MODEL);
    assert.equal(Object.keys(getLlmModelHealthStatus()).length, 1);

    const start = originalDateNow();
    Date.now = () => start + MODEL_QUARANTINE_MS + 1;

    // Two rejections a fortnight apart are not "consecutive" in any useful
    // sense, and the stale record must not linger in the map either.
    assert.deepEqual(getLlmModelHealthStatus(), {});
    recordModelFailure(OPENROUTER, DEAD_MODEL, 400, OPENROUTER_UNKNOWN_MODEL);
    assert.equal(isModelUsable(OPENROUTER, DEAD_MODEL), true);
  });

  it('scopes the quarantine to one origin+model pair', () => {
    for (let i = 0; i < MODEL_FAILURE_THRESHOLD; i += 1) {
      recordModelFailure(OPENROUTER, DEAD_MODEL, 400, OPENROUTER_UNKNOWN_MODEL);
    }

    assert.equal(isModelUsable(OPENROUTER, DEAD_MODEL), false);
    assert.equal(
      isModelUsable(OPENROUTER, 'deepseek/deepseek-v4-flash'),
      true,
      'a sibling model on the same provider stays usable',
    );
    assert.equal(
      isModelUsable(GROQ, DEAD_MODEL),
      true,
      'the same model ID on another provider stays usable',
    );
  });

  it('tolerates a malformed provider URL and an empty model instead of throwing', () => {
    assert.equal(isModelUsable('not-a-url', DEAD_MODEL), true);
    assert.equal(isModelUsable(OPENROUTER, ''), true);
    recordModelFailure('not-a-url', DEAD_MODEL, 400, OPENROUTER_UNKNOWN_MODEL);
    recordModelFailure(OPENROUTER, '', 400, OPENROUTER_UNKNOWN_MODEL);
    assert.deepEqual(getLlmModelHealthStatus(), {});
  });
});

describe('getLlmModelHealthStatus', () => {
  it('surfaces the quarantine the origin-only status cannot show', () => {
    for (let i = 0; i < MODEL_FAILURE_THRESHOLD; i += 1) {
      recordModelFailure(OPENROUTER, DEAD_MODEL, 400, OPENROUTER_UNKNOWN_MODEL);
    }

    const status = getLlmModelHealthStatus();
    const key = `https://openrouter.ai|${DEAD_MODEL}`;
    assert.ok(status[key], 'the quarantined model must be keyed by origin|model');
    assert.equal(status[key].quarantined, true);
    assert.equal(status[key].failures, MODEL_FAILURE_THRESHOLD);
    assert.equal(status[key].lastStatus, 400);
    assert.ok(status[key].quarantinedUntil > originalDateNow());
  });
});
