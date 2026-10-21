import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  COMPANY_MONITORING_EXA_CONTRACT,
  compileExaCohortDiscovery,
  compileExaConfirmationQuery,
  createExaCohortExecutor,
} from '../scripts/lib/company-monitoring-exa.mjs';

const fixtureUrl = new URL('./fixtures/company-monitoring-exa/provider-contract.json', import.meta.url);
const protocolUrl = new URL('./fixtures/company-monitoring-evaluation/protocol.json', import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));
const protocol = JSON.parse(await readFile(protocolUrl, 'utf8'));

const WINDOW_START = Date.parse('2026-08-09T00:00:00.000Z');
const WINDOW_END = Date.parse('2026-08-10T00:00:00.000Z');

function work(overrides = {}) {
  return {
    workId: 'cm_work_fixture',
    source: 'exa',
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    resultCap: 25,
    queryVersion: fixture.frozenDiscovery.queryVersion,
    obligations: fixture.frozenDiscovery.companies.map((company) => ({
      companyId: company.companyId,
      company: {
        name: company.name,
        domicileCountry: company.domicileCountry,
        claims: company.claims,
      },
    })),
    ...overrides,
  };
}

function response(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Company Monitoring bounded Exa discovery contract', () => {
  it('matches the frozen Stage 0 protocol without enabling paid runtime', () => {
    assert.equal(COMPANY_MONITORING_EXA_CONTRACT.contractVersion, fixture.contractVersion);
    assert.equal(COMPANY_MONITORING_EXA_CONTRACT.queryVersion, fixture.frozenDiscovery.queryVersion);
    assert.equal(
      COMPANY_MONITORING_EXA_CONTRACT.confirmationQueryVersion,
      fixture.frozenDiscovery.confirmationQueryVersion,
    );
    assert.deepEqual(COMPANY_MONITORING_EXA_CONTRACT.limits, fixture.limits);
    assert.equal(COMPANY_MONITORING_EXA_CONTRACT.paidRuntimeApproved, false);
    assert.equal(protocol.protocolVersion, fixture.protocolVersion);
    assert.equal(protocol.stage0.decision, 'stop');
    assert.ok(protocol.stage0.permittedImplementation.includes('dark_contracts'));
    assert.ok(protocol.stage0.forbiddenUntilContinue.includes('paid_provider_runtime'));
    assert.equal(
      protocol.economics.assumptions.exaResultsPerSearch,
      COMPANY_MONITORING_EXA_CONTRACT.limits.resultsPerSearch,
    );
    assert.equal(
      protocol.economics.assumptions.exaBaseUsdPerSearch,
      fixture.pricing.baseUsdPerSearch,
    );
    assert.equal(
      protocol.economics.assumptions.exaAdditionalResultUsd,
      fixture.pricing.additionalResultUsd,
    );
  });

  it('compiles the frozen discovery query from validated claims and keeps confirmation disjoint', () => {
    const discovery = compileExaCohortDiscovery(work().obligations);
    assert.equal(discovery.query, fixture.frozenDiscovery.expectedQuery);
    assert.equal(discovery.queryVersion, fixture.frozenDiscovery.queryVersion);
    assert.deepEqual(
      discovery.includedCompanies.map(({ companyId }) => companyId),
      fixture.frozenDiscovery.companies.map(({ companyId }) => companyId),
    );
    assert.deepEqual(discovery.omittedCompanies, []);

    const confirmation = compileExaConfirmationQuery({
      company: work().obligations[0],
      candidate: {
        title: 'Acme signs a material supply contract',
        url: 'https://news.example/acme-contract',
      },
    });
    assert.equal(confirmation.queryVersion, fixture.frozenDiscovery.confirmationQueryVersion);
    assert.notEqual(confirmation.query, discovery.query);
    assert.equal(confirmation.query.includes('WorldMonitor discovery v1'), false);
    assert.equal(discovery.query.includes('WorldMonitor confirmation v1'), false);
  });

  it('preserves contract-valid long legal identifiers or closes the company as a byte omission', () => {
    const longIdentifier = 'L'.repeat(300);
    const obligation = {
      companyId: 'cm_company_00000000000000000000000003',
      company: {
        name: 'Long Identifier Company',
        domicileCountry: 'US',
        claims: [{
          claimId: 'cm_claim_00000000000000000000000004',
          type: 'legal_identifier',
          value: longIdentifier,
        }],
      },
    };

    const included = compileExaCohortDiscovery([obligation]);
    assert.deepEqual(included.includedCompanies, [{
      companyId: obligation.companyId,
      claimCount: 1,
    }]);
    assert.deepEqual(included.omittedCompanies, []);
    assert.ok(included.query.includes(`identifiers=["${longIdentifier}"]`));

    const projectedAtClaimCap = {
      ...obligation,
      company: {
        ...obligation.company,
        claims: Array.from({ length: 12 }, (_, index) => ({
          claimId: `cm_claim_${String(index + 10).padStart(26, '0')}`,
          type: 'legal_identifier',
          value: `${String(index).padStart(2, '0')}${longIdentifier}`,
        })),
      },
    };
    const omitted = compileExaCohortDiscovery([projectedAtClaimCap]);
    assert.deepEqual(omitted.includedCompanies, []);
    assert.deepEqual(omitted.omittedCompanies, [{
      companyId: obligation.companyId,
      reason: 'query_byte_limit',
    }]);
  });

  it('neutralizes query operators and reports every company omitted by validation or byte packing', () => {
    const unsafe = {
      companyId: 'cm_company_00000000000000000000000003',
      company: {
        name: `Needle" OR site:attacker.example -safe`,
        domicileCountry: 'US',
        claims: [
          { claimId: 'cm_claim_00000000000000000000000004', type: 'alias', value: 'Needle) OR (*:*' },
          { claimId: 'cm_claim_00000000000000000000000005', type: 'domain', value: 'attacker.example) OR (' },
        ],
      },
    };
    const invalid = {
      companyId: 'cm_company_00000000000000000000000004',
      company: { name: 'Wrong Domicile', domicileCountry: 'CA', claims: [] },
    };
    const oversized = {
      companyId: 'cm_company_00000000000000000000000005',
      company: { name: `Very Long ${'Company '.repeat(20)}`, domicileCountry: 'GB', claims: [] },
    };

    const compiled = compileExaCohortDiscovery([unsafe, invalid, oversized], { maxQueryBytes: 310 });
    assert.ok(compiled.queryBytes <= 310);
    assert.equal(compiled.query.includes('site:'), false);
    assert.equal(compiled.query.includes('*:*'), false);
    assert.equal(compiled.query.includes('-safe'), false);
    assert.equal(compiled.query.includes('attacker.example'), false);
    assert.deepEqual(compiled.includedCompanies.map(({ companyId }) => companyId), [unsafe.companyId]);
    assert.deepEqual(compiled.omittedCompanies, [
      { companyId: invalid.companyId, reason: 'invalid_company_claims' },
      { companyId: oversized.companyId, reason: 'query_byte_limit' },
    ]);
  });

  it('rotates production-limit packing so a stable cohort cannot starve the same tail', () => {
    const obligations = Array.from({ length: 25 }, (_, index) => ({
      companyId: `cm_company_${String(index + 1).padStart(26, '0')}`,
      company: {
        name: `Company ${String(index + 1).padStart(2, '0')}`,
        domicileCountry: index % 2 === 0 ? 'US' : 'GB',
        claims: [],
      },
    }));
    const first = compileExaCohortDiscovery(obligations, { packingOffset: 0 });
    const second = compileExaCohortDiscovery(obligations, { packingOffset: 1 });

    for (const compiled of [first, second]) {
      assert.ok(compiled.queryBytes <= COMPANY_MONITORING_EXA_CONTRACT.limits.queryUtf8Bytes);
      assert.equal(compiled.requestedCompanies, obligations.length);
      assert.equal(
        compiled.includedCompanies.length + compiled.omittedCompanies.length,
        obligations.length,
      );
      assert.ok(compiled.omittedCompanies.length > 0);
    }
    assert.notEqual(
      first.includedCompanies[0].companyId,
      second.includedCompanies[0].companyId,
    );
    assert.notDeepEqual(
      first.omittedCompanies.map(({ companyId }) => companyId),
      second.omittedCompanies.map(({ companyId }) => companyId),
    );
  });

  it('returns provider windows, row-based checkpoints, attributable cost, and unresolved candidates', async () => {
    const requests = [];
    const execute = createExaCohortExecutor({
      apiKeys: ['exa-key-one'],
      runtimeApproved: true,
      now: () => WINDOW_END + 1234,
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return response(fixture.successResponse);
      },
    });

    const execution = await execute(work());
    assert.deepEqual(execution.finalizeResult, {
      type: 'result',
      itemCount: 2,
      hasMore: false,
      coverage: 'complete',
      returnedRange: { startAt: WINDOW_START, endAt: WINDOW_END },
      checkpoint: execution.finalizeResult.checkpoint,
      emptyValidated: false,
      costUsdMicros: 22_000,
      exaIngestion: execution.finalizeResult.exaIngestion,
    });
    assert.match(execution.finalizeResult.checkpoint, /^exa_rows_v1\./);
    assert.equal(execution.finalizeResult.exaIngestion.candidates.length, 2);
    assert.deepEqual(execution.finalizeResult.exaIngestion.candidates[0], {
      providerResultId: fixture.successResponse.results[0].id,
      providerRequestId: fixture.successResponse.requestId,
      providerRank: 1,
      url: fixture.successResponse.results[0].url,
      title: fixture.successResponse.results[0].title,
      author: fixture.successResponse.results[0].author,
      publishedAt: Date.parse(fixture.successResponse.results[0].publishedDate),
      retrievedAt: WINDOW_END + 1234,
      candidateCompanyIds: work().obligations.map((row) => row.companyId),
    });
    const checkpointPayload = JSON.parse(Buffer.from(
      execution.finalizeResult.checkpoint.split('.')[1],
      'base64url',
    ).toString('utf8'));
    assert.equal(checkpointPayload.publishedAt, Date.parse('2026-08-09T13:00:00.000Z'));
    assert.equal(checkpointPayload.rows, 2);
    assert.deepEqual(execution.report.publicationWindow, {
      startAt: WINDOW_START,
      endAt: WINDOW_END,
    });
    assert.deepEqual(execution.report.retrievedWindow, {
      startedAt: WINDOW_END + 1234,
      completedAt: WINDOW_END + 1234,
    });
    assert.deepEqual(execution.report.counts, {
      requestedCompanies: 2,
      includedCompanies: 2,
      omittedCompanies: 0,
      providerRows: 2,
      validRows: 2,
      malformedRows: 0,
    });
    assert.deepEqual(execution.report.pagination, {
      kind: 'bounded_single_page',
      page: 1,
      requestedResults: 25,
      providerMaximumResults: 100,
      hasMore: false,
      providerCursor: null,
      nextCheckpoint: execution.finalizeResult.checkpoint,
    });
    assert.equal(execution.report.requests.attempted, 1);
    assert.equal(execution.report.cost.usdMicros, 22_000);
    assert.equal(execution.report.cost.basis, 'provider_reported');
    assert.equal('query' in execution.report, false, 'tenant query text must not enter provider reports');
    assert.equal(execution.report.candidates.length, 2);
    assert.ok(execution.report.candidates.every((candidate) =>
      candidate.candidateState === 'pending_attribution' && candidate.acceptedCompanyIds.length === 0
    ));
    assert.equal(execution.report.candidates[0].publishedAt, Date.parse('2026-08-09T12:00:00.000Z'));
    assert.equal(requests[0].url, 'https://api.exa.ai/search');
    assert.equal(requests[0].init.headers['x-api-key'], 'exa-key-one');
    assert.deepEqual(JSON.parse(requests[0].init.body), {
      query: fixture.frozenDiscovery.expectedQuery,
      type: 'auto',
      category: 'news',
      startPublishedDate: '2026-08-09T00:00:00.000Z',
      endPublishedDate: '2026-08-10T00:00:00.000Z',
      numResults: 25,
    });
  });

  it('marks a packed query with explicit omissions as partial so checkpoints cannot advance', async () => {
    const execute = createExaCohortExecutor({
      apiKeys: ['exa-key-one'],
      runtimeApproved: true,
      fetchImpl: async () => response(fixture.successResponse),
    });
    const invalidCompany = {
      companyId: 'cm_company_00000000000000000000000009',
      company: { name: 'Invalid Domicile', domicileCountry: 'CA', claims: [] },
      checkpoint: 'checkpoint-before',
    };

    const execution = await execute(work({ obligations: [...work().obligations, invalidCompany] }));
    assert.equal(execution.finalizeResult.coverage, 'partial');
    assert.equal(execution.report.outcome, 'partial');
    assert.deepEqual(execution.report.omittedCompanies, [{
      companyId: invalidCompany.companyId,
      reason: 'invalid_company_claims',
    }]);
  });

  it('marks a full result page as capped and exposes the non-cursor pagination boundary', async () => {
    const results = Array.from({ length: 25 }, (_, index) => ({
      id: `https://news.example/result-${String(index).padStart(2, '0')}`,
      url: `https://news.example/result-${String(index).padStart(2, '0')}`,
      title: `Result ${index}`,
      publishedDate: `2026-08-09T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
    }));
    const execute = createExaCohortExecutor({
      apiKeys: ['exa-key-one'],
      runtimeApproved: true,
      fetchImpl: async () => response({
        requestId: 'exa-request-capped',
        results,
        costDollars: { total: 0.022 },
      }),
    });

    const execution = await execute(work());
    assert.equal(execution.finalizeResult.itemCount, 25);
    assert.equal(execution.finalizeResult.hasMore, true);
    assert.equal(execution.report.pagination.hasMore, true);
    assert.equal(execution.report.pagination.providerCursor, null);
    assert.equal(execution.report.pagination.nextCheckpoint, null);
    assert.equal(execution.report.outcome, 'capped');
  });

  it('preserves the checkpoint contract when provider rows are malformed', async () => {
    const execute = createExaCohortExecutor({
      apiKeys: ['exa-key-one'],
      runtimeApproved: true,
      fetchImpl: async () => response(fixture.malformedResponse),
    });

    const execution = await execute(work({
      obligations: work().obligations.map((obligation) => ({
        ...obligation,
        checkpoint: 'checkpoint-before',
      })),
    }));
    assert.deepEqual(execution.finalizeResult, {
      type: 'result',
      itemCount: 1,
      hasMore: false,
      coverage: 'partial',
      returnedRange: { startAt: WINDOW_START, endAt: WINDOW_END },
      emptyValidated: false,
      costUsdMicros: 22_000,
      exaIngestion: { candidates: [] },
    });
    assert.equal(execution.report.outcome, 'malformed');
    assert.equal(execution.report.counts.malformedRows, 1);
    assert.equal(execution.report.pagination.nextCheckpoint, null);
  });

  it('rotates keys after timeout and counts each request and cost exactly once', async () => {
    const keys = [];
    const execute = createExaCohortExecutor({
      apiKeys: ['exa-key-two', 'exa-key-two', 'exa-key-one'],
      runtimeApproved: true,
      now: () => WINDOW_END,
      fetchImpl: async (_url, init) => {
        keys.push(init.headers['x-api-key']);
        if (keys.length === 1) {
          const error = new Error('request timed out');
          error.name = 'TimeoutError';
          throw error;
        }
        return response(fixture.successResponse);
      },
    });

    const execution = await execute(work());
    assert.deepEqual(keys, ['exa-key-two', 'exa-key-one']);
    assert.equal(execution.report.requests.attempted, 2);
    assert.equal(execution.report.requests.timedOut, 1);
    assert.equal(execution.report.requests.completed, 1);
    assert.equal(execution.report.cost.usdMicros, 44_000);
    assert.equal(execution.finalizeResult.costUsdMicros, 44_000);
    assert.equal(execution.report.cost.basis, 'mixed');
    assert.equal(JSON.stringify(execution.report).includes('exa-key-one'), false);
    assert.equal(JSON.stringify(execution.report).includes('exa-key-two'), false);
  });

  it('caps an oversized all-failure key list at primary plus fallback', async () => {
    const configuredKeys = Array.from({ length: 30 }, (_, index) => `exa-key-${index + 1}`);
    const calledKeys = [];
    const execute = createExaCohortExecutor({
      apiKeys: configuredKeys,
      runtimeApproved: true,
      timeoutMs: Number.MAX_SAFE_INTEGER,
      now: () => WINDOW_END,
      fetchImpl: async (_url, init) => {
        calledKeys.push(init.headers['x-api-key']);
        const error = new Error('request timed out');
        error.name = 'TimeoutError';
        throw error;
      },
    });

    const execution = await execute(work());
    assert.equal(COMPANY_MONITORING_EXA_CONTRACT.limits.providerAttemptsMaximum, 2);
    assert.equal(COMPANY_MONITORING_EXA_CONTRACT.limits.providerRequestTimeoutMs, 12_000);
    assert.deepEqual(calledKeys, configuredKeys.slice(0, 2));
    assert.equal(execution.report.caps.providerMaximumAttempts, 2);
    assert.equal(execution.report.caps.providerRequestTimeoutMs, 12_000);
    assert.deepEqual(execution.finalizeResult, {
      type: 'provider_error',
      reason: 'timeout',
      costUsdMicros: 44_000,
    });
    assert.deepEqual(execution.report.requests, {
      attempted: 2,
      completed: 0,
      timedOut: 2,
    });
    assert.equal(execution.report.cost.attempts.length, 2);
  });

  it('does not rotate credentials for a request-specific 403 rejection', async () => {
    let calls = 0;
    const execute = createExaCohortExecutor({
      apiKeys: ['exa-key-one', 'exa-key-two'],
      runtimeApproved: true,
      fetchImpl: async () => {
        calls += 1;
        return response({ requestId: 'exa-request-filtered' }, { status: 403 });
      },
    });

    const execution = await execute(work());
    assert.equal(calls, 1);
    assert.deepEqual(execution.finalizeResult, {
      type: 'provider_error',
      reason: 'request_rejected',
      costUsdMicros: 22_000,
    });
  });

  it('cannot perform a paid request while the frozen runtime gate is dark', async () => {
    let calls = 0;
    const execute = createExaCohortExecutor({
      apiKeys: ['exa-key-one'],
      fetchImpl: async () => {
        calls += 1;
        return response(fixture.successResponse);
      },
    });

    const execution = await execute(work());
    assert.deepEqual(execution.finalizeResult, {
      type: 'provider_error',
      reason: 'provider_unavailable',
      costUsdMicros: 0,
    });
    assert.equal(execution.report.outcome, 'runtime_not_approved');
    assert.equal(calls, 0);
  });
});
