import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildCompanyMonitoringClassificationRequest,
} from '../scripts/lib/company-monitoring-classification.mjs';
import {
  COMPANY_MONITORING_CLASSIFIER_ENDPOINT,
  COMPANY_MONITORING_CLASSIFIER_MAX_TIMEOUT_MS,
  CompanyMonitoringClassifierTransportError,
  requestCompanyMonitoringClassification,
} from '../scripts/lib/company-monitoring-classifier-client.mjs';

const candidate = {
  ownerAccountId: 'account-1',
  companyId: 'company-1',
  occurrenceDedupeKey: 'occurrence-1',
  firstDiscoveredAt: 1_700_000_000_000,
  attemptCount: 0,
  expiresAt: 1_700_259_200_000,
  referenceEvidenceFingerprints: ['evidence-1'],
  referencesTruncated: false,
  selectionPolicyVersion: 'selection-v1',
};

const evidence = [{
  ownerAccountId: 'account-1',
  companyId: 'company-1',
  occurrenceDedupeKey: 'occurrence-1',
  evidenceFingerprint: 'evidence-1',
  provider: 'exa',
  providerLocator: 'https://example.com/story',
  providerOriginFingerprint: 'origin-1',
  sourceAuthority: 'independent_source',
  independence: 'independent',
  queryVersion: 'query-v1',
  title: 'Company signs material contract',
  text: 'The company signed a material customer contract.',
  publishedAt: 1_700_000_000_000,
  observedAt: 1_700_000_060_000,
}];

const apiKey = 'openrouter-test-key';
const model = 'provider/classifier-model';

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

describe('company-monitoring classifier client', () => {
  it('sends the exact strict-schema request without tools and returns untrusted JSON', async () => {
    const untrustedOutput = { arbitrary: 'model-owned-shape' };
    let requestUrl: string | URL | Request | undefined;
    let requestInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (url, init) => {
      requestUrl = url;
      requestInit = init;
      return jsonResponse({
        model,
        choices: [{
          finish_reason: 'stop',
          message: { role: 'assistant', content: JSON.stringify(untrustedOutput) },
        }],
      });
    };

    const result = await requestCompanyMonitoringClassification({
      candidate,
      evidence,
      apiKey,
      model,
      fetchImpl,
      timeoutMs: 5_000,
    });

    assert.deepEqual(result, {
      content: JSON.stringify(untrustedOutput),
      resolvedModel: model,
    });
    assert.equal(requestUrl, COMPANY_MONITORING_CLASSIFIER_ENDPOINT);
    assert.equal(requestInit?.method, 'POST');
    assert.ok(requestInit?.signal instanceof AbortSignal);
    const headers = requestInit?.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${apiKey}`);
    assert.equal(headers['Content-Type'], 'application/json');
    assert.equal(headers['HTTP-Referer'], 'https://worldmonitor.app');
    assert.equal(headers['X-Title'], 'World Monitor');
    assert.match(headers['User-Agent'], /^WorldMonitor-CompanyMonitoring\//);

    const body = JSON.parse(String(requestInit?.body));
    assert.deepEqual(body, buildCompanyMonitoringClassificationRequest({ candidate, evidence, model }));
    assert.equal('tools' in body, false);
    assert.equal('tool_choice' in body, false);
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.response_format.json_schema.strict, true);
  });

  it('fails before fetch when the API key or model is missing', async () => {
    let fetchCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      fetchCalls += 1;
      return jsonResponse({ choices: [] });
    };

    for (const config of [
      { apiKey: '', model },
      { apiKey, model: '' },
      { apiKey: '   ', model },
      { apiKey, model: '   ' },
    ]) {
      await assert.rejects(
        requestCompanyMonitoringClassification({ candidate, evidence, fetchImpl, ...config }),
        (error: unknown) =>
          error instanceof CompanyMonitoringClassifierTransportError && error.code === 'configuration',
      );
    }
    assert.equal(fetchCalls, 0);
  });

  it('rejects invalid or excessive timeout budgets before fetch', async () => {
    let fetchCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      fetchCalls += 1;
      return jsonResponse({ choices: [] });
    };

    for (const timeoutMs of [0, -1, 1.5, COMPANY_MONITORING_CLASSIFIER_MAX_TIMEOUT_MS + 1]) {
      await assert.rejects(
        requestCompanyMonitoringClassification({
          candidate,
          evidence,
          apiKey,
          model,
          fetchImpl,
          timeoutMs,
        }),
        (error: unknown) =>
          error instanceof CompanyMonitoringClassifierTransportError && error.code === 'configuration',
      );
    }
    assert.equal(fetchCalls, 0);
  });

  it('fails closed on non-success HTTP responses without parsing provider content', async () => {
    const fetchImpl: typeof fetch = async () => new Response('provider detail', {
      status: 503,
      statusText: 'Unavailable',
    });

    await assert.rejects(
      requestCompanyMonitoringClassification({ candidate, evidence, apiKey, model, fetchImpl }),
      (error: unknown) =>
        error instanceof CompanyMonitoringClassifierTransportError &&
        error.code === 'http' &&
        error.status === 503 &&
        !error.message.includes('provider detail'),
    );
  });

  it('aborts a request at the configured timeout', async () => {
    const fetchImpl: typeof fetch = async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });

    await assert.rejects(
      requestCompanyMonitoringClassification({
        candidate,
        evidence,
        apiKey,
        model,
        fetchImpl,
        timeoutMs: 5,
      }),
      (error: unknown) =>
        error instanceof CompanyMonitoringClassifierTransportError && error.code === 'timeout',
    );
  });

  it('returns malformed content from a complete choice unchanged for deterministic rejection', async () => {
    for (const content of ['not-json', '', '{"partial":']) {
      const fetchImpl: typeof fetch = async () => jsonResponse({
        model,
        choices: [{
          finish_reason: 'stop',
          message: { role: 'assistant', content },
        }],
      });

      const result = await requestCompanyMonitoringClassification({
        candidate,
        evidence,
        apiKey,
        model,
        fetchImpl,
      });

      assert.deepEqual(result, { content, resolvedModel: model });
    }
  });

  it('fails closed when the provider omits the resolved model identity', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: '{}' },
      }],
    });

    await assert.rejects(
      requestCompanyMonitoringClassification({ candidate, evidence, apiKey, model, fetchImpl }),
      (error: unknown) =>
        error instanceof CompanyMonitoringClassifierTransportError &&
        error.code === 'provider_response' &&
        error.message.includes('attest'),
    );
  });

  it('fails closed when routing returns an unapproved resolved model identity', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({
      model: 'provider/routed-model',
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: '{}' },
      }],
    });

    await assert.rejects(
      requestCompanyMonitoringClassification({ candidate, evidence, apiKey, model, fetchImpl }),
      (error: unknown) =>
        error instanceof CompanyMonitoringClassifierTransportError &&
        error.code === 'provider_response' &&
        error.message.includes('unapproved'),
    );
  });

  it('returns an explicitly approved routed model identity separately from content', async () => {
    const resolvedModel = 'provider/routed-model';
    const fetchImpl: typeof fetch = async () => jsonResponse({
      model: resolvedModel,
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: '{}' },
      }],
    });

    assert.deepEqual(await requestCompanyMonitoringClassification({
      candidate,
      evidence,
      apiKey,
      model,
      approvedResolvedModels: [resolvedModel],
      fetchImpl,
    }), {
      content: '{}',
      resolvedModel,
    });
  });

  it('fails closed when a choice did not finish normally', async () => {
    for (const finishReason of ['length', 'content_filter']) {
      const fetchImpl: typeof fetch = async () => jsonResponse({
        model,
        choices: [{
          finish_reason: finishReason,
          message: { role: 'assistant', content: '{}' },
        }],
      });

      await assert.rejects(
        requestCompanyMonitoringClassification({ candidate, evidence, apiKey, model, fetchImpl }),
        (error: unknown) =>
          error instanceof CompanyMonitoringClassifierTransportError &&
          error.code === 'provider_response',
      );
    }
  });

  it('fails closed before parsing an oversized provider envelope', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({
      model,
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'x'.repeat(300_000) },
      }],
    });

    await assert.rejects(
      requestCompanyMonitoringClassification({ candidate, evidence, apiKey, model, fetchImpl }),
      (error: unknown) =>
        error instanceof CompanyMonitoringClassifierTransportError &&
        error.code === 'provider_response',
    );
  });

  it('fails closed on malformed provider envelopes or content', async () => {
    const badResponses = [
      new Response('not-json', { status: 200 }),
      jsonResponse({}),
      jsonResponse({ model, choices: [] }),
      jsonResponse({ choices: [
        { finish_reason: 'stop', message: { role: 'assistant', content: '{}' } },
        { finish_reason: 'stop', message: { role: 'assistant', content: '{}' } },
      ] }),
      jsonResponse({ model, choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: { not: 'a string' } },
      }] }),
      jsonResponse({ model, choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: '{}', refusal: 'cannot comply' },
      }] }),
      jsonResponse({ model, choices: [{ message: { role: 'assistant', content: '{}' } }] }),
    ];

    for (const response of badResponses) {
      const fetchImpl: typeof fetch = async () => response;
      await assert.rejects(
        requestCompanyMonitoringClassification({ candidate, evidence, apiKey, model, fetchImpl }),
        (error: unknown) =>
          error instanceof CompanyMonitoringClassifierTransportError && error.code === 'provider_response',
      );
    }
  });
});
