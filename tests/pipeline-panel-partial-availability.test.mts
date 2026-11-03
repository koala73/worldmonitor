import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { shouldErrorOnPipelineLiveResponse } from '../src/shared/pipeline-live-paint.ts';

describe('PipelineStatusPanel live paint gate — partial availability', () => {
  test('keeps partial rows when one registry is missing', () => {
    assert.equal(
      shouldErrorOnPipelineLiveResponse({
        pipelines: [{ id: 'gas1' } as never],
        upstreamUnavailable: true,
      }),
      false,
    );
  });

  test('errors only when the live response is empty and unavailable', () => {
    assert.equal(
      shouldErrorOnPipelineLiveResponse({ pipelines: [], upstreamUnavailable: true }),
      true,
    );
  });

  test('does not error on a healthy empty registry', () => {
    assert.equal(
      shouldErrorOnPipelineLiveResponse({ pipelines: [], upstreamUnavailable: false }),
      false,
    );
  });

  test('errors when pipelines is missing and upstream is unavailable', () => {
    assert.equal(
      shouldErrorOnPipelineLiveResponse({
        pipelines: undefined as never,
        upstreamUnavailable: true,
      }),
      true,
    );
  });
});
