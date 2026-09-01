import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  getProductionImperativeToolNames,
  runWebMcpEvalCli,
  scorePredictions,
  validateEvalFixture,
} from '../scripts/evaluate-webmcp-evals.mjs';

const fixturePath = new URL('./fixtures/webmcp/evals.v1.json', import.meta.url);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function caseById(value, id) {
  const evalCase = value.cases.find((candidate) => candidate.id === id);
  assert.ok(evalCase, `missing fixture case ${id}`);
  return evalCase;
}

function perfectPredictions(value = fixture) {
  return {
    version: 'webmcp_predictions_v1',
    fixtureVersion: value.version,
    cases: value.cases.map((evalCase) => {
      const alternatePlanCases = new Set([
        'dashboard_controls_alternate_order',
        'country_brief_ambiguous',
      ]);
      const planIndex = alternatePlanCases.has(evalCase.id) ? 1 : 0;
      const prediction = {
        id: evalCase.id,
        steps: clone(evalCase.expectedPlans[planIndex]),
      };
      if (evalCase.failure) {
        prediction.observedFailure = {
          atStep: evalCase.failure.atStep,
          tool: evalCase.failure.tool,
          reason: evalCase.failure.reason,
        };
      }
      return prediction;
    }),
  };
}

function resultById(report, id) {
  const result = report.cases.find((candidate) => candidate.id === id);
  assert.ok(result, `missing score result ${id}`);
  return result;
}

describe('offline WebMCP eval corpus', () => {
  it('matches the real imperative tool inventory and preserves the required coverage matrix', () => {
    const coverage = validateEvalFixture(fixture);

    assert.deepEqual(fixture.toolInventory.imperative, getProductionImperativeToolNames());
    assert.equal(coverage.caseCount, 39);
    assert.deepEqual(coverage.categoryCounts, {
      dashboard_context: 6,
      dashboard_control: 24,
      country_brief: 2,
      search_selection: 3,
      procurement: 3,
      negative: 1,
    });
    assert.equal(coverage.directCount, 32);
    assert.equal(coverage.ambiguousCount, 7);
    assert.equal(coverage.alternatePlanCaseCount, 3);
    assert.equal(coverage.failureCaseCount, 5);
    assert.equal(coverage.midChainFailureCaseCount, 4);
    assert.equal(coverage.wrongToolNegativeCaseCount, 39);
    assert.equal(coverage.symbolicBindingCount, 3);
  });

  it('rejects inventory drift and arguments that fail production imperative schemas', () => {
    const inventoryDrift = clone(fixture);
    inventoryDrift.toolInventory.imperative.pop();
    assert.throws(
      () => validateEvalFixture(inventoryDrift),
      /must exactly match buildWebMcpTools/,
    );

    const invalidCountryCode = clone(fixture);
    caseById(invalidCountryCode, 'country_brief_direct')
      .expectedPlans[0][0].arguments.iso2 = 'IRN';
    assert.throws(
      () => validateEvalFixture(invalidCountryCode),
      /openCountryBrief schema/,
    );

    const invalidMapView = clone(fixture);
    caseById(invalidMapView, 'dashboard_controls_alternate_order')
      .expectedPlans[0][1].arguments.view = 'europe';
    assert.throws(
      () => validateEvalFixture(invalidMapView),
      /set_map_view schema/,
    );
  });

  it('rejects declarative procurement arguments outside the live form limits', () => {
    const overlongQuery = clone(fixture);
    caseById(overlongQuery, 'procurement_direct')
      .expectedPlans[0][0].arguments.query = 'q'.repeat(161);
    assert.throws(
      () => validateEvalFixture(overlongQuery),
      /search_procurement schema/,
    );

    const overlongBuyer = clone(fixture);
    caseById(overlongBuyer, 'procurement_ambiguous')
      .expectedPlans[0][0].arguments.buyer = 'b'.repeat(161);
    assert.throws(
      () => validateEvalFixture(overlongBuyer),
      /search_procurement schema/,
    );

    const astralQueryBeyondHtmlMaxLength = clone(fixture);
    caseById(astralQueryBeyondHtmlMaxLength, 'procurement_direct')
      .expectedPlans[0][0].arguments.query = '\ud83d\ude80'.repeat(81);
    assert.throws(
      () => validateEvalFixture(astralQueryBeyondHtmlMaxLength),
      /UTF-16 code-unit limit/,
    );

    for (const invalidCountry of ['C', 'CAN', 'C1', '\u00c7A']) {
      const invalidCountryCode = clone(fixture);
      caseById(invalidCountryCode, 'procurement_direct')
        .expectedPlans[0][0].arguments.country = invalidCountry;
      assert.throws(
        () => validateEvalFixture(invalidCountryCode),
        /search_procurement schema/,
      );
    }
  });

  it('requires dynamic search keys to be symbolic references to an earlier search step', () => {
    const fabricatedKey = clone(fixture);
    caseById(fabricatedKey, 'dashboard_search_and_select')
      .expectedPlans[0][1].arguments.resultKey = `sr_${'a'.repeat(32)}`;
    assert.throws(
      () => validateEvalFixture(fabricatedKey),
      /must use a symbolic search-result binding/,
    );

    const forwardReference = clone(fixture);
    caseById(forwardReference, 'dashboard_search_and_select')
      .expectedPlans[0][1].arguments.resultKey = '$steps[1].results[0].key';
    assert.throws(
      () => validateEvalFixture(forwardReference),
      /must reference an earlier step/,
    );
  });

  it('rejects alternate plans that differ only by schema defaults', () => {
    const duplicateDefaultPlan = clone(fixture);
    const searchCase = caseById(duplicateDefaultPlan, 'dashboard_search_list_only');
    const explicitDefaults = clone(searchCase.expectedPlans[0]);
    explicitDefaults[0].arguments.scope = 'all';
    explicitDefaults[0].arguments.limit = 8;
    searchCase.expectedPlans.push(explicitDefaults);

    assert.throws(
      () => validateEvalFixture(duplicateDefaultPlan),
      /duplicates another expected plan/,
    );
  });
});

describe('offline WebMCP prediction scorer', () => {
  it('accepts valid alternate plans and exact injected failure traces', () => {
    const report = scorePredictions(fixture, perfectPredictions());

    assert.equal(report.status, 'passed');
    assert.deepEqual(report.summary, {
      total: 39,
      passed: 39,
      failed: 0,
      unexpected: 0,
    });
    assert.equal(resultById(report, 'dashboard_controls_alternate_order').matchedPlan, 2);
    assert.equal(resultById(report, 'country_brief_ambiguous').matchedPlan, 2);
    assert.deepEqual(
      resultById(report, 'search_selection_stale_key_failure').errors,
      [],
    );
  });

  it('normalizes schema defaults without ignoring a requested non-default limit', () => {
    const explicitDefaults = perfectPredictions();
    const defaultedSearch = caseById(explicitDefaults, 'dashboard_search_list_only');
    defaultedSearch.steps[0].arguments.scope = 'all';
    defaultedSearch.steps[0].arguments.limit = 8;
    const explicitDefaultsReport = scorePredictions(fixture, explicitDefaults);
    assert.equal(explicitDefaultsReport.status, 'passed');
    assert.deepEqual(
      resultById(explicitDefaultsReport, 'dashboard_search_list_only').errors,
      [],
    );

    const explicitFormDefaults = perfectPredictions();
    const procurement = caseById(explicitFormDefaults, 'procurement_ambiguous');
    procurement.steps[0].arguments.buyer = '';
    procurement.steps[0].arguments.country = '';
    procurement.steps[0].arguments.techRelevant = false;
    const explicitFormDefaultsReport = scorePredictions(fixture, explicitFormDefaults);
    assert.equal(explicitFormDefaultsReport.status, 'passed');
    assert.deepEqual(
      resultById(explicitFormDefaultsReport, 'procurement_ambiguous').errors,
      [],
    );

    const omittedDefaultScope = perfectPredictions();
    delete caseById(omittedDefaultScope, 'dashboard_search_and_select')
      .steps[0].arguments.scope;
    const defaultScopeReport = scorePredictions(fixture, omittedDefaultScope);
    assert.equal(defaultScopeReport.status, 'passed');
    assert.deepEqual(
      resultById(defaultScopeReport, 'dashboard_search_and_select').errors,
      [],
    );

    const omittedRequestedLimit = perfectPredictions();
    delete caseById(omittedRequestedLimit, 'dashboard_search_and_select')
      .steps[0].arguments.limit;
    const omittedLimitReport = scorePredictions(fixture, omittedRequestedLimit);
    assert.deepEqual(
      resultById(omittedLimitReport, 'dashboard_search_and_select').errors,
      ['plan_mismatch'],
    );

    const differentLimit = perfectPredictions();
    caseById(differentLimit, 'dashboard_search_and_select')
      .steps[0].arguments.limit = 6;
    const differentLimitReport = scorePredictions(fixture, differentLimit);
    assert.deepEqual(
      resultById(differentLimitReport, 'dashboard_search_and_select').errors,
      ['plan_mismatch'],
    );
  });

  it('scores forbidden wrong tools and invalid production arguments as case failures', () => {
    const wrongTool = perfectPredictions();
    const contextPrediction = caseById(wrongTool, 'dashboard_context_direct');
    contextPrediction.steps = [{ tool: 'openSearch', arguments: {} }];
    const wrongToolReport = scorePredictions(fixture, wrongTool);
    assert.equal(wrongToolReport.status, 'failed');
    assert.deepEqual(resultById(wrongToolReport, 'dashboard_context_direct').errors, [
      'forbidden_tool_called',
      'plan_mismatch',
    ]);

    const invalidArguments = perfectPredictions();
    caseById(invalidArguments, 'country_brief_direct').steps[0].arguments.iso2 = 'IRN';
    const invalidArgumentsReport = scorePredictions(fixture, invalidArguments);
    const errors = resultById(invalidArgumentsReport, 'country_brief_direct').errors;
    assert.ok(errors.some((error) => error.includes('openCountryBrief schema')));
    assert.ok(errors.includes('plan_mismatch'));
  });

  it('rejects fabricated result keys and calls made after an injected mid-chain failure', () => {
    const fabricatedKey = perfectPredictions();
    caseById(fabricatedKey, 'dashboard_search_and_select')
      .steps[1].arguments.resultKey = `sr_${'b'.repeat(32)}`;
    const fabricatedKeyReport = scorePredictions(fixture, fabricatedKey);
    assert.ok(
      resultById(fabricatedKeyReport, 'dashboard_search_and_select').errors
        .some((error) => error.includes('must use a symbolic search-result binding')),
    );

    const continuedAfterFailure = perfectPredictions();
    caseById(continuedAfterFailure, 'dashboard_control_entitlement_failure').steps.push({
      tool: 'set_map_view',
      arguments: { view: 'mena' },
    });
    const continuedReport = scorePredictions(fixture, continuedAfterFailure);
    const errors = resultById(
      continuedReport,
      'dashboard_control_entitlement_failure',
    ).errors;
    assert.ok(errors.includes('plan_mismatch'));
    assert.ok(errors.includes('calls_after_failure'));
    assert.ok(errors.includes('forbidden_fallback_after_failure'));
  });

  it('validates and scores JSON artifacts without invoking an external model', () => {
    const validateResult = runWebMcpEvalCli([]);
    assert.equal(validateResult.exitCode, 0);
    assert.equal(JSON.parse(validateResult.stdout).status, 'valid');

    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'worldmonitor-webmcp-eval-'));
    try {
      const predictionsPath = join(temporaryDirectory, 'predictions.json');
      writeFileSync(predictionsPath, `${JSON.stringify(perfectPredictions())}\n`);
      const first = runWebMcpEvalCli(['--predictions', predictionsPath]);
      const second = runWebMcpEvalCli(['--predictions', predictionsPath]);
      assert.equal(first.exitCode, 0);
      assert.equal(first.stderr, '');
      assert.equal(first.stdout, second.stdout, 'the report must be deterministic');
      assert.equal(JSON.parse(first.stdout).status, 'passed');
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
