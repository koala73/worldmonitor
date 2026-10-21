import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildCompanyMonitoringClassificationRequest,
} from '../scripts/lib/company-monitoring-classification.mjs';
import {
  COMPANY_MONITORING_CLASSIFIER_ENDPOINT,
  COMPANY_MONITORING_CLASSIFIER_MAX_TIMEOUT_MS,
  CompanyMonitoringClassifierTransportError,
  requestCompanyMonitoringClassification as requestCompanyMonitoringClassificationTransport,
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
const providerRoute = 'provider-route';
const expectedResolvedProvider = 'Pinned Provider';
const attemptId = 'cm_attempt_00000000-0000-4000-8000-000000000001';

function requestCompanyMonitoringClassification(
  input: Parameters<typeof requestCompanyMonitoringClassificationTransport>[0],
) {
  return requestCompanyMonitoringClassificationTransport({
    expectedResolvedProvider,
    attemptId,
    ...input,
  });
}

function routerMetadata(resolvedModel = model, provider = 'Pinned Provider') {
  return {
    requested: model,
    strategy: 'direct',
    attempt: 1,
    endpoints: {
      total: 1,
      available: [{ provider, model: resolvedModel, selected: true }],
    },
    attempts: [{ provider, model: resolvedModel, status: 200 }],
    pipeline: [],
  };
}

function successEnvelope(content: string, resolvedModel = model) {
  return {
    id: 'gen-company-monitoring-1',
    model: resolvedModel,
    provider: 'Pinned Provider',
    usage: { cost: 0.001 },
    openrouter_metadata: routerMetadata(resolvedModel),
    choices: [{
      finish_reason: 'stop',
      message: { role: 'assistant', content },
    }],
  };
}

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
      return jsonResponse(successEnvelope(JSON.stringify(untrustedOutput)));
    };

    const result = await requestCompanyMonitoringClassification({
      candidate,
      evidence,
      apiKey,
      model,
      providerRoute,
      fetchImpl,
      timeoutMs: 5_000,
    });

    assert.deepEqual(result, {
      providerResponseId: 'gen-company-monitoring-1',
      content: JSON.stringify(untrustedOutput),
      route: {
        resolvedModel: model,
        resolvedProvider: 'Pinned Provider',
        configuredProviderRoute: providerRoute,
      },
      costUsd: 0.001,
    });
    assert.equal(requestUrl, COMPANY_MONITORING_CLASSIFIER_ENDPOINT);
    assert.equal(requestInit?.method, 'POST');
    assert.ok(requestInit?.signal instanceof AbortSignal);
    const headers = requestInit?.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${apiKey}`);
    assert.equal(headers['Content-Type'], 'application/json');
    assert.equal(headers['HTTP-Referer'], 'https://worldmonitor.app');
    assert.equal(headers['X-Title'], 'World Monitor');
    assert.equal(headers['X-OpenRouter-Metadata'], 'enabled');
    assert.match(headers['User-Agent'], /^WorldMonitor-CompanyMonitoring\//);

    const body = JSON.parse(String(requestInit?.body));
    assert.deepEqual(body, {
      ...buildCompanyMonitoringClassificationRequest({ candidate, evidence, model }),
      temperature: 0,
      reasoning: { effort: 'none' },
      metadata: { company_monitoring_attempt_id: attemptId },
      trace: { trace_id: attemptId },
      provider: {
        only: [providerRoute],
        allow_fallbacks: false,
        require_parameters: true,
        data_collection: 'deny',
        zdr: true,
      },
    });
    assert.equal('tools' in body, false);
    assert.equal('tool_choice' in body, false);
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.response_format.json_schema.strict, true);
    const modelInput = JSON.parse(body.messages[1].content.split('\n')[1]);
    assert.equal('occurrenceDedupeKey' in modelInput.candidate, false);
  });

  it('fails before fetch when the API key or model is missing', async () => {
    let fetchCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      fetchCalls += 1;
      return jsonResponse({ choices: [] });
    };

    for (const config of [
      { apiKey: '', model, providerRoute },
      { apiKey, model: '', providerRoute },
      { apiKey: '   ', model, providerRoute },
      { apiKey, model: '   ', providerRoute },
      { apiKey, model, providerRoute: '' },
      { apiKey, model, providerRoute: '   ' },
    ]) {
      await assert.rejects(
        requestCompanyMonitoringClassification({ candidate, evidence, fetchImpl, ...config }),
        (error: unknown) =>
          error instanceof CompanyMonitoringClassifierTransportError && error.code === 'configuration',
      );
    }
    await assert.rejects(
      requestCompanyMonitoringClassificationTransport({
        candidate,
        evidence,
        apiKey,
        model,
        providerRoute,
        fetchImpl,
      }),
      (error: unknown) =>
        error instanceof CompanyMonitoringClassifierTransportError && error.code === 'configuration',
    );
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
          providerRoute,
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
      requestCompanyMonitoringClassification({ candidate, evidence, apiKey, model, providerRoute, fetchImpl }),
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
        providerRoute,
        fetchImpl,
        timeoutMs: 5,
      }),
      (error: unknown) =>
        error instanceof CompanyMonitoringClassifierTransportError && error.code === 'timeout',
    );
  });

  it('returns malformed content from a complete choice unchanged for deterministic rejection', async () => {
    for (const content of ['not-json', '', '{"partial":']) {
      const fetchImpl: typeof fetch = async () => jsonResponse(successEnvelope(content));

      const result = await requestCompanyMonitoringClassification({
        candidate,
        evidence,
        apiKey,
        model,
        providerRoute,
        fetchImpl,
      });

      assert.deepEqual(result, {
        providerResponseId: 'gen-company-monitoring-1',
        content,
        route: {
          resolvedModel: model,
          resolvedProvider: 'Pinned Provider',
          configuredProviderRoute: providerRoute,
        },
        costUsd: 0.001,
      });
    }
  });

  it('fails closed when the provider omits the resolved model identity', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({
      id: 'gen-company-monitoring-1',
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: '{}' },
      }],
    });

    await assert.rejects(
      requestCompanyMonitoringClassification({ candidate, evidence, apiKey, model, providerRoute, fetchImpl }),
      (error: unknown) =>
        error instanceof CompanyMonitoringClassifierTransportError &&
        error.code === 'provider_response' &&
        error.message.includes('attest'),
    );
  });

  it('fails closed when routing returns an unapproved resolved model identity', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse(successEnvelope('{}', 'provider/routed-model'));

    await assert.rejects(
      requestCompanyMonitoringClassification({ candidate, evidence, apiKey, model, providerRoute, fetchImpl }),
      (error: unknown) =>
        error instanceof CompanyMonitoringClassifierTransportError &&
        error.code === 'provider_response' &&
        error.message.includes('unapproved'),
    );
  });

  it('returns an explicitly approved routed model identity separately from content', async () => {
    const resolvedModel = 'provider/routed-model';
    const fetchImpl: typeof fetch = async () => jsonResponse(successEnvelope('{}', resolvedModel));

    assert.deepEqual(await requestCompanyMonitoringClassification({
      candidate,
      evidence,
      apiKey,
      model,
      providerRoute,
      approvedResolvedModels: [resolvedModel],
      fetchImpl,
    }), {
      providerResponseId: 'gen-company-monitoring-1',
      content: '{}',
      route: {
        resolvedModel,
        resolvedProvider: 'Pinned Provider',
        configuredProviderRoute: providerRoute,
      },
      costUsd: 0.001,
    });
  });

  it('fails closed when a choice did not finish normally', async () => {
    for (const finishReason of ['length', 'content_filter']) {
      const envelope: ReturnType<typeof successEnvelope> = successEnvelope('{}');
      envelope.choices[0]!.finish_reason = finishReason;
      const fetchImpl: typeof fetch = async () => jsonResponse(envelope);

      await assert.rejects(
        requestCompanyMonitoringClassification({ candidate, evidence, apiKey, model, providerRoute, fetchImpl }),
        (error: unknown) =>
          error instanceof CompanyMonitoringClassifierTransportError &&
          error.code === 'provider_response',
      );
    }
  });

  it('fails closed before parsing an oversized provider envelope', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse(successEnvelope('x'.repeat(300_000)));

    await assert.rejects(
      requestCompanyMonitoringClassification({ candidate, evidence, apiKey, model, providerRoute, fetchImpl }),
      (error: unknown) =>
        error instanceof CompanyMonitoringClassifierTransportError &&
        error.code === 'provider_response',
    );
  });

  it('fails closed on malformed provider envelopes or content', async () => {
    const invalidContent = successEnvelope('{}');
    invalidContent.choices[0]!.message.content = { not: 'a string' } as unknown as string;
    const refused = successEnvelope('{}');
    Object.assign(refused.choices[0]!.message, { refusal: 'cannot comply' });
    const toolCall = successEnvelope('{}');
    Object.assign(toolCall.choices[0]!.message, { tool_calls: [{ id: 'tool-1' }] });
    const badResponses = [
      new Response('not-json', { status: 200 }),
      jsonResponse({}),
      jsonResponse({ model, provider: 'Pinned Provider', openrouter_metadata: routerMetadata(), choices: [] }),
      jsonResponse({ choices: [
        { finish_reason: 'stop', message: { role: 'assistant', content: '{}' } },
        { finish_reason: 'stop', message: { role: 'assistant', content: '{}' } },
      ] }),
      jsonResponse(invalidContent),
      jsonResponse(refused),
      jsonResponse(toolCall),
      jsonResponse({ model, choices: [{ message: { role: 'assistant', content: '{}' } }] }),
    ];

    for (const response of badResponses) {
      const fetchImpl: typeof fetch = async () => response;
      await assert.rejects(
        requestCompanyMonitoringClassification({ candidate, evidence, apiKey, model, providerRoute, fetchImpl }),
        (error: unknown) =>
          error instanceof CompanyMonitoringClassifierTransportError && error.code === 'provider_response',
      );
    }
  });

  it('fails closed when OpenRouter does not attest the pinned provider route', async () => {
    const invalidMetadata = [
      undefined,
      { ...routerMetadata(), attempt: 2 },
      { ...routerMetadata(), requested: 'provider/other-model' },
      { ...routerMetadata(), strategy: 'fallback' },
      {
        ...routerMetadata(),
        endpoints: { total: 1, available: [{ provider: 'Other Provider', model, selected: true }] },
      },
      { ...routerMetadata(), attempts: [{ provider: 'Pinned Provider', model, status: 503 }] },
      { ...routerMetadata(), attempts: {} },
      { ...routerMetadata(), pipeline: {} },
      { ...routerMetadata(), pipeline: [{ type: 'response_healing' }] },
    ];

    for (const openrouterMetadata of invalidMetadata) {
      const envelope = successEnvelope('{}') as Record<string, unknown>;
      if (openrouterMetadata === undefined) delete envelope.openrouter_metadata;
      else envelope.openrouter_metadata = openrouterMetadata;
      const fetchImpl: typeof fetch = async () => jsonResponse(envelope);
      await assert.rejects(
        requestCompanyMonitoringClassification({
          candidate,
          evidence,
          apiKey,
          model,
          providerRoute,
          fetchImpl,
        }),
        (error: unknown) =>
          error instanceof CompanyMonitoringClassifierTransportError &&
          error.code === 'provider_response',
      );
    }
  });

  it('binds every returned provider identity to the configured expected provider', async () => {
    const coherentWrongProvider = successEnvelope('{}');
    coherentWrongProvider.provider = 'Other Provider';
    coherentWrongProvider.openrouter_metadata = routerMetadata(model, 'Other Provider');
    const contradictoryProvider = successEnvelope('{}');
    contradictoryProvider.provider = 'Other Provider';

    for (const envelope of [coherentWrongProvider, contradictoryProvider]) {
      await assert.rejects(
        requestCompanyMonitoringClassification({
          candidate,
          evidence,
          apiKey,
          model,
          providerRoute,
          expectedResolvedProvider,
          fetchImpl: async () => jsonResponse(envelope),
        }),
        (error: unknown) =>
          error instanceof CompanyMonitoringClassifierTransportError &&
          error.code === 'provider_response',
      );
    }
  });

  it('accepts a direct first-attempt route when optional attempts metadata is absent', async () => {
    const envelope = successEnvelope('{}');
    delete (envelope.openrouter_metadata as Partial<ReturnType<typeof routerMetadata>>).attempts;
    const result = await requestCompanyMonitoringClassification({
      candidate,
      evidence,
      apiKey,
      model,
      providerRoute,
      fetchImpl: async () => jsonResponse(envelope),
    });

    assert.equal(result.route.resolvedProvider, 'Pinned Provider');
  });

  it('rejects any returned reasoning despite the disabled-reasoning request', async () => {
    const envelope = successEnvelope('{}');
    Object.assign(envelope.choices[0]!.message, { reasoning: 'unexpected' });
    const fetchImpl: typeof fetch = async () => jsonResponse(envelope);

    await assert.rejects(
      requestCompanyMonitoringClassification({
        candidate,
        evidence,
        apiKey,
        model,
        providerRoute,
        fetchImpl,
      }),
      (error: unknown) =>
        error instanceof CompanyMonitoringClassifierTransportError &&
        error.code === 'provider_response',
    );
  });

  it('fails closed when OpenRouter omits or corrupts request cost', async () => {
    for (const usage of [undefined, {}, { cost: -1 }, { cost: Number.NaN }]) {
      const envelope = successEnvelope('{}') as Record<string, unknown>;
      if (usage === undefined) delete envelope.usage;
      else envelope.usage = usage;
      const fetchImpl: typeof fetch = async () => jsonResponse(envelope);
      await assert.rejects(
        requestCompanyMonitoringClassification({
          candidate,
          evidence,
          apiKey,
          model,
          providerRoute,
          fetchImpl,
        }),
        (error: unknown) =>
          error instanceof CompanyMonitoringClassifierTransportError &&
          error.code === 'provider_response',
      );
    }
  });
});
