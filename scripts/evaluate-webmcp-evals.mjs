#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv from 'ajv';
import {
  WEBMCP_PROCUREMENT_COUNTRY_CODE_CHARS,
  WEBMCP_PROCUREMENT_COUNTRY_CODE_PATTERN,
  WEBMCP_PROCUREMENT_TEXT_MAX_CHARS,
} from '../src/config/webmcp.ts';
import { buildWebMcpTools } from '../src/services/webmcp.ts';

const FIXTURE_VERSION = 'webmcp_eval_v1';
const PREDICTION_VERSION = 'webmcp_predictions_v1';
const REPORT_VERSION = 'webmcp_eval_report_v1';
const SYMBOL_SYNTAX = '$steps[<zero-based-step-index>].results[<zero-based-result-index>].key';
const SYMBOL_PATTERN = /^\$steps\[(\d+)]\.results\[(\d+)]\.key$/;
const REPRESENTATIVE_SEARCH_RESULT_KEY = `sr_${'a'.repeat(32)}`;
const DEFAULT_SEARCH_RESULT_LIMIT = 8;
const DEFAULT_FIXTURE_PATH = fileURLToPath(
  new URL('../tests/fixtures/webmcp/evals.v1.json', import.meta.url),
);

const REQUIRED_CATEGORIES = [
  'dashboard_context',
  'dashboard_control',
  'country_brief',
  'search_selection',
  'procurement',
  'negative',
];
const PROMPT_KINDS = new Set(['direct', 'ambiguous']);

// This is the declarative form contract exposed by GlobalProcurementPanel. The
// imperative schemas below are not copied: they are compiled directly from the
// tools returned by the production buildWebMcpTools function.
const DECLARATIVE_TOOL_SCHEMAS = new Map([
  ['search_procurement', {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        maxLength: WEBMCP_PROCUREMENT_TEXT_MAX_CHARS,
        default: '',
      },
      buyer: {
        type: 'string',
        maxLength: WEBMCP_PROCUREMENT_TEXT_MAX_CHARS,
        default: '',
      },
      country: {
        type: 'string',
        maxLength: WEBMCP_PROCUREMENT_COUNTRY_CODE_CHARS,
        anyOf: [
          { const: '' },
          {
            minLength: WEBMCP_PROCUREMENT_COUNTRY_CODE_CHARS,
            pattern: WEBMCP_PROCUREMENT_COUNTRY_CODE_PATTERN,
          },
        ],
        default: '',
      },
      source: {
        type: 'string',
        enum: ['', 'sam', 'ted', 'contracts-finder', 'canada-buys', 'gets', 'world-bank'],
        default: '',
      },
      sort: {
        type: 'string',
        enum: ['closing_soon', 'newest', 'estimated_value', 'relevance'],
        default: 'closing_soon',
      },
      techRelevant: { type: 'boolean', default: false },
    },
    additionalProperties: false,
  }],
]);

const noOpTrack = () => {};
const productionTools = buildWebMcpTools({}, noOpTrack);
const productionToolNames = productionTools.map((tool) => tool.name);
const toolSchemas = new Map([
  ...productionTools.map((tool) => [tool.name, tool.inputSchema]),
  ...DECLARATIVE_TOOL_SCHEMAS,
]);
const ajv = new Ajv({ allErrors: true, strict: false });
const imperativeValidators = new Map(
  productionTools.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]),
);
const declarativeValidators = new Map(
  [...DECLARATIVE_TOOL_SCHEMAS].map(([name, schema]) => [name, ajv.compile(schema)]),
);
const knownToolNames = new Set([
  ...productionToolNames,
  ...DECLARATIVE_TOOL_SCHEMAS.keys(),
]);

export class WebMcpEvalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WebMcpEvalError';
  }
}

function fail(path, message) {
  throw new WebMcpEvalError(`${path}: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value, path) {
  if (!isRecord(value)) fail(path, 'must be an object');
  return value;
}

function requireString(value, path, { nonEmpty = true } = {}) {
  if (typeof value !== 'string') fail(path, 'must be a string');
  if (nonEmpty && value.trim() === '') fail(path, 'must not be empty');
  return value;
}

function requireStringArray(value, path, { nonEmpty = false } = {}) {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  if (nonEmpty && value.length === 0) fail(path, 'must not be empty');
  const strings = value.map((entry, index) => requireString(entry, `${path}[${index}]`));
  if (new Set(strings).size !== strings.length) fail(path, 'must not contain duplicates');
  return strings;
}

function requireExactKeys(value, path, required, optional = []) {
  const object = requireRecord(value, path);
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.hasOwn(object, key));
  if (missing.length > 0) fail(path, `missing keys: ${missing.join(', ')}`);
  const extra = Object.keys(object).filter((key) => !allowed.has(key));
  if (extra.length > 0) fail(path, `unknown keys: ${extra.sort().join(', ')}`);
  return object;
}

function sameStringArray(actual, expected) {
  return actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function normalizePlanDefaults(plan) {
  return plan.map((step) => {
    if (!isRecord(step) || typeof step.tool !== 'string' || !isRecord(step.arguments)) {
      return step;
    }
    const schema = toolSchemas.get(step.tool);
    if (!isRecord(schema) || !isRecord(schema.properties)) return step;

    const normalizedArguments = { ...step.arguments };
    for (const [propertyName, propertySchema] of Object.entries(schema.properties)) {
      if (
        !Object.hasOwn(normalizedArguments, propertyName)
        && isRecord(propertySchema)
        && Object.hasOwn(propertySchema, 'default')
      ) {
        normalizedArguments[propertyName] = propertySchema.default;
      }
    }
    return { ...step, arguments: normalizedArguments };
  });
}

function formatAjvErrors(errors) {
  return (errors ?? []).map((error) => {
    const location = error.instancePath || '/';
    return `${location} ${error.message ?? error.keyword}`;
  }).join(', ');
}

function resolveSymbolicArguments(tool, args, plan, stepIndex, path, errors) {
  let validationArgs = args;
  if (tool === 'open_search_result' && typeof args.resultKey === 'string') {
    const match = SYMBOL_PATTERN.exec(args.resultKey);
    if (!match) {
      errors.push(`${path}.arguments.resultKey must use a symbolic search-result binding`);
      return validationArgs;
    }
    const sourceStepIndex = Number(match[1]);
    const resultIndex = Number(match[2]);
    if (sourceStepIndex >= stepIndex) {
      errors.push(`${path}.arguments.resultKey must reference an earlier step`);
    } else {
      const sourceStep = plan[sourceStepIndex];
      if (!isRecord(sourceStep) || sourceStep.tool !== 'search_dashboard') {
        errors.push(
          `${path}.arguments.resultKey must reference a search_dashboard result`,
        );
      } else {
        const sourceArgs = isRecord(sourceStep.arguments) ? sourceStep.arguments : {};
        const limit = Number.isInteger(sourceArgs.limit)
          ? Number(sourceArgs.limit)
          : DEFAULT_SEARCH_RESULT_LIMIT;
        if (resultIndex >= limit) {
          errors.push(
            `${path}.arguments.resultKey references result ${resultIndex} beyond search limit ${limit}`,
          );
        }
      }
    }
    validationArgs = { ...args, resultKey: REPRESENTATIVE_SEARCH_RESULT_KEY };
  }
  return validationArgs;
}

function declarativeFormSemanticErrors(tool, args, path) {
  if (tool !== 'search_procurement') return [];
  const errors = [];
  for (const field of ['query', 'buyer']) {
    const value = args[field];
    // HTML maxlength and the live runtime count UTF-16 code units, whereas
    // JSON Schema maxLength counts Unicode code points. Preserve the stricter
    // browser-form contract for astral characters as well as ASCII input.
    if (typeof value === 'string' && value.length > WEBMCP_PROCUREMENT_TEXT_MAX_CHARS) {
      errors.push(
        `${path}.arguments.${field} exceeds the live form's ${WEBMCP_PROCUREMENT_TEXT_MAX_CHARS} UTF-16 code-unit limit`,
      );
    }
  }
  return errors;
}

function planSemanticErrors(plan, path) {
  const errors = [];
  if (!Array.isArray(plan)) return [`${path} must be an array`];

  for (let index = 0; index < plan.length; index += 1) {
    const stepPath = `${path}[${index}]`;
    const step = plan[index];
    if (!isRecord(step)) {
      errors.push(`${stepPath} must be an object`);
      continue;
    }
    const keys = Object.keys(step);
    const unexpectedKeys = keys.filter((key) => key !== 'tool' && key !== 'arguments');
    if (!Object.hasOwn(step, 'tool') || !Object.hasOwn(step, 'arguments')) {
      errors.push(`${stepPath} must contain exactly tool and arguments`);
      continue;
    }
    if (unexpectedKeys.length > 0) {
      errors.push(`${stepPath} has unknown keys: ${unexpectedKeys.sort().join(', ')}`);
    }
    if (typeof step.tool !== 'string' || !knownToolNames.has(step.tool)) {
      errors.push(`${stepPath}.tool is not a known WebMCP tool`);
      continue;
    }
    if (!isRecord(step.arguments)) {
      errors.push(`${stepPath}.arguments must be an object`);
      continue;
    }

    const validationArgs = resolveSymbolicArguments(
      step.tool,
      step.arguments,
      plan,
      index,
      stepPath,
      errors,
    );
    const validator = imperativeValidators.get(step.tool)
      ?? declarativeValidators.get(step.tool);
    if (!validator(validationArgs)) {
      errors.push(
        `${stepPath}.arguments fails the ${step.tool} schema: ${formatAjvErrors(validator.errors)}`,
      );
    }
    errors.push(...declarativeFormSemanticErrors(step.tool, validationArgs, stepPath));
  }
  return errors;
}

function validateKnownToolList(tools, path) {
  for (const tool of tools) {
    if (!knownToolNames.has(tool)) fail(path, `unknown WebMCP tool: ${tool}`);
  }
}

function validateFailure(value, path, plans) {
  const failure = requireExactKeys(
    value,
    path,
    ['atStep', 'tool', 'reason', 'mustStop', 'forbiddenAfterFailure'],
  );
  if (!Number.isInteger(failure.atStep) || failure.atStep < 1) {
    fail(`${path}.atStep`, 'must be a positive one-based integer');
  }
  const tool = requireString(failure.tool, `${path}.tool`);
  if (!knownToolNames.has(tool)) fail(`${path}.tool`, `unknown WebMCP tool: ${tool}`);
  requireString(failure.reason, `${path}.reason`);
  if (failure.mustStop !== true) fail(`${path}.mustStop`, 'must be true');
  const forbiddenAfterFailure = requireStringArray(
    failure.forbiddenAfterFailure,
    `${path}.forbiddenAfterFailure`,
    { nonEmpty: true },
  );
  validateKnownToolList(forbiddenAfterFailure, `${path}.forbiddenAfterFailure`);

  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index];
    if (plan.length !== failure.atStep) {
      fail(
        `${path}.atStep`,
        `expectedPlans[${index}] must stop at the injected failure step`,
      );
    }
    if (plan[failure.atStep - 1]?.tool !== tool) {
      fail(
        `${path}.tool`,
        `expectedPlans[${index}] does not fail on ${tool} at step ${failure.atStep}`,
      );
    }
  }
  return failure;
}

export function getProductionImperativeToolNames() {
  return [...productionToolNames];
}

export function validateEvalFixture(value) {
  const fixture = requireExactKeys(
    value,
    'fixture',
    ['version', 'description', 'toolInventory', 'symbolSyntax', 'cases'],
  );
  if (fixture.version !== FIXTURE_VERSION) {
    fail('fixture.version', `must equal ${FIXTURE_VERSION}`);
  }
  requireString(fixture.description, 'fixture.description');
  if (fixture.symbolSyntax !== SYMBOL_SYNTAX) {
    fail('fixture.symbolSyntax', `must equal ${SYMBOL_SYNTAX}`);
  }

  const inventory = requireExactKeys(
    fixture.toolInventory,
    'fixture.toolInventory',
    ['imperative', 'declarative'],
  );
  const imperative = requireStringArray(
    inventory.imperative,
    'fixture.toolInventory.imperative',
    { nonEmpty: true },
  );
  const declarative = requireStringArray(
    inventory.declarative,
    'fixture.toolInventory.declarative',
    { nonEmpty: true },
  );
  if (!sameStringArray(imperative, productionToolNames)) {
    fail(
      'fixture.toolInventory.imperative',
      `must exactly match buildWebMcpTools: ${productionToolNames.join(', ')}`,
    );
  }
  const expectedDeclarative = [...DECLARATIVE_TOOL_SCHEMAS.keys()];
  if (!sameStringArray(declarative, expectedDeclarative)) {
    fail(
      'fixture.toolInventory.declarative',
      `must exactly match the declarative tool contract: ${expectedDeclarative.join(', ')}`,
    );
  }

  if (!Array.isArray(fixture.cases) || fixture.cases.length === 0) {
    fail('fixture.cases', 'must be a non-empty array');
  }
  const ids = new Set();
  const categoryCounts = Object.fromEntries(REQUIRED_CATEGORIES.map((category) => [category, 0]));
  let directCount = 0;
  let ambiguousCount = 0;
  let alternatePlanCaseCount = 0;
  let failureCaseCount = 0;
  let midChainFailureCaseCount = 0;
  let wrongToolNegativeCaseCount = 0;
  let symbolicBindingCount = 0;

  fixture.cases.forEach((caseValue, caseIndex) => {
    const path = `fixture.cases[${caseIndex}]`;
    const evalCase = requireExactKeys(
      caseValue,
      path,
      ['id', 'category', 'promptKind', 'prompt', 'expectedPlans', 'forbiddenTools'],
      ['failure'],
    );
    const id = requireString(evalCase.id, `${path}.id`);
    if (!/^[a-z0-9_]+$/.test(id)) fail(`${path}.id`, 'must use lowercase snake_case');
    if (ids.has(id)) fail(`${path}.id`, `duplicate case ID: ${id}`);
    ids.add(id);

    const category = requireString(evalCase.category, `${path}.category`);
    if (!Object.hasOwn(categoryCounts, category)) {
      fail(`${path}.category`, `must be one of: ${REQUIRED_CATEGORIES.join(', ')}`);
    }
    categoryCounts[category] += 1;
    const promptKind = requireString(evalCase.promptKind, `${path}.promptKind`);
    if (!PROMPT_KINDS.has(promptKind)) {
      fail(`${path}.promptKind`, 'must be direct or ambiguous');
    }
    if (promptKind === 'direct') directCount += 1;
    else ambiguousCount += 1;
    requireString(evalCase.prompt, `${path}.prompt`);

    if (!Array.isArray(evalCase.expectedPlans) || evalCase.expectedPlans.length === 0) {
      fail(`${path}.expectedPlans`, 'must be a non-empty array');
    }
    const planDigests = new Set();
    evalCase.expectedPlans.forEach((plan, planIndex) => {
      const planPath = `${path}.expectedPlans[${planIndex}]`;
      const errors = planSemanticErrors(plan, planPath);
      if (errors.length > 0) fail(planPath, errors.join('; '));
      const digest = canonicalJson(normalizePlanDefaults(plan));
      if (planDigests.has(digest)) fail(planPath, 'duplicates another expected plan');
      planDigests.add(digest);
      symbolicBindingCount += plan.filter((step) => (
        step.tool === 'open_search_result'
        && typeof step.arguments.resultKey === 'string'
        && SYMBOL_PATTERN.test(step.arguments.resultKey)
      )).length;
    });
    if (evalCase.expectedPlans.length > 1) alternatePlanCaseCount += 1;

    const forbiddenTools = requireStringArray(
      evalCase.forbiddenTools,
      `${path}.forbiddenTools`,
      { nonEmpty: true },
    );
    validateKnownToolList(forbiddenTools, `${path}.forbiddenTools`);
    const expectedTools = new Set(
      evalCase.expectedPlans.flatMap((plan) => plan.map((step) => step.tool)),
    );
    const overlap = forbiddenTools.filter((tool) => expectedTools.has(tool));
    if (overlap.length > 0) {
      fail(`${path}.forbiddenTools`, `also contains expected tools: ${overlap.join(', ')}`);
    }
    wrongToolNegativeCaseCount += 1;

    if (Object.hasOwn(evalCase, 'failure')) {
      const failure = validateFailure(evalCase.failure, `${path}.failure`, evalCase.expectedPlans);
      failureCaseCount += 1;
      if (failure.atStep > 1) midChainFailureCaseCount += 1;
    }
  });

  const missingCategories = REQUIRED_CATEGORIES.filter((category) => categoryCounts[category] === 0);
  if (missingCategories.length > 0) {
    fail('fixture.cases', `missing required categories: ${missingCategories.join(', ')}`);
  }
  if (directCount === 0 || ambiguousCount === 0) {
    fail('fixture.cases', 'must include direct and ambiguous prompts');
  }
  if (alternatePlanCaseCount === 0) {
    fail('fixture.cases', 'must include at least one case with valid alternate plans');
  }
  if (midChainFailureCaseCount === 0) {
    fail('fixture.cases', 'must include at least one injected failure after step one');
  }
  if (symbolicBindingCount === 0) {
    fail('fixture.cases', 'must include a symbolic search-result binding');
  }

  return {
    fixtureVersion: fixture.version,
    caseCount: fixture.cases.length,
    categoryCounts,
    directCount,
    ambiguousCount,
    alternatePlanCaseCount,
    failureCaseCount,
    midChainFailureCaseCount,
    wrongToolNegativeCaseCount,
    symbolicBindingCount,
  };
}

function validatePredictionArtifactShape(value) {
  const predictions = requireExactKeys(
    value,
    'predictions',
    ['version', 'fixtureVersion', 'cases'],
  );
  if (predictions.version !== PREDICTION_VERSION) {
    fail('predictions.version', `must equal ${PREDICTION_VERSION}`);
  }
  if (predictions.fixtureVersion !== FIXTURE_VERSION) {
    fail('predictions.fixtureVersion', `must equal ${FIXTURE_VERSION}`);
  }
  if (!Array.isArray(predictions.cases)) fail('predictions.cases', 'must be an array');

  const ids = new Set();
  predictions.cases.forEach((caseValue, index) => {
    const path = `predictions.cases[${index}]`;
    const prediction = requireExactKeys(caseValue, path, ['id', 'steps'], ['observedFailure']);
    const id = requireString(prediction.id, `${path}.id`);
    if (ids.has(id)) fail(`${path}.id`, `duplicate prediction ID: ${id}`);
    ids.add(id);
    if (!Array.isArray(prediction.steps)) fail(`${path}.steps`, 'must be an array');
    if (Object.hasOwn(prediction, 'observedFailure')) {
      requireExactKeys(
        prediction.observedFailure,
        `${path}.observedFailure`,
        ['atStep', 'tool', 'reason'],
      );
    }
  });
  return predictions;
}

function failureErrors(expectedFailure, observedFailure, steps) {
  const errors = [];
  if (!expectedFailure) {
    if (observedFailure !== undefined) errors.push('unexpected_observed_failure');
    return errors;
  }
  if (!observedFailure) {
    errors.push('missing_observed_failure');
  } else {
    if (observedFailure.atStep !== expectedFailure.atStep) {
      errors.push('wrong_failure_step');
    }
    if (observedFailure.tool !== expectedFailure.tool) errors.push('wrong_failure_tool');
    if (observedFailure.reason !== expectedFailure.reason) errors.push('wrong_failure_reason');
  }
  if (expectedFailure.mustStop && steps.length > expectedFailure.atStep) {
    errors.push('calls_after_failure');
  }
  const callsAfterFailure = steps.slice(expectedFailure.atStep);
  const forbiddenAfter = new Set(expectedFailure.forbiddenAfterFailure);
  if (callsAfterFailure.some((step) => isRecord(step) && forbiddenAfter.has(step.tool))) {
    errors.push('forbidden_fallback_after_failure');
  }
  return errors;
}

function matchingPlanIndex(expectedPlans, steps) {
  const actual = canonicalJson(normalizePlanDefaults(steps));
  return expectedPlans.findIndex((plan) => (
    canonicalJson(normalizePlanDefaults(plan)) === actual
  ));
}

export function scorePredictions(fixtureValue, predictionValue) {
  const coverage = validateEvalFixture(fixtureValue);
  const fixture = fixtureValue;
  const predictions = validatePredictionArtifactShape(predictionValue);
  const predictionById = new Map(
    predictions.cases.map((prediction) => [prediction.id, prediction]),
  );
  const fixtureIds = new Set(fixture.cases.map((evalCase) => evalCase.id));
  const unexpectedPredictionIds = [...predictionById.keys()]
    .filter((id) => !fixtureIds.has(id))
    .sort();

  const cases = fixture.cases.map((evalCase) => {
    const prediction = predictionById.get(evalCase.id);
    if (!prediction) {
      return {
        id: evalCase.id,
        passed: false,
        matchedPlan: null,
        errors: ['missing_prediction'],
      };
    }

    const errors = planSemanticErrors(
      prediction.steps,
      `prediction ${evalCase.id}.steps`,
    );
    const forbiddenTools = new Set(evalCase.forbiddenTools);
    if (prediction.steps.some((step) => isRecord(step) && forbiddenTools.has(step.tool))) {
      errors.push('forbidden_tool_called');
    }
    const matchIndex = matchingPlanIndex(evalCase.expectedPlans, prediction.steps);
    if (matchIndex === -1) errors.push('plan_mismatch');
    errors.push(...failureErrors(evalCase.failure, prediction.observedFailure, prediction.steps));
    const uniqueErrors = [...new Set(errors)];
    return {
      id: evalCase.id,
      passed: uniqueErrors.length === 0,
      matchedPlan: matchIndex === -1 ? null : matchIndex + 1,
      errors: uniqueErrors,
    };
  });
  const passed = cases.filter((result) => result.passed).length;
  const failed = cases.length - passed;
  const status = failed === 0 && unexpectedPredictionIds.length === 0 ? 'passed' : 'failed';
  return {
    version: REPORT_VERSION,
    mode: 'score',
    status,
    fixtureVersion: fixture.version,
    predictionVersion: predictions.version,
    summary: {
      total: cases.length,
      passed,
      failed,
      unexpected: unexpectedPredictionIds.length,
    },
    coverage,
    unexpectedPredictionIds,
    cases,
  };
}

function usage() {
  return [
    'usage:',
    '  node --import tsx scripts/evaluate-webmcp-evals.mjs [--fixture FILE] [--predictions FILE]',
    '',
    'Without --predictions, validates the offline corpus and production tool schemas.',
    'With --predictions, deterministically scores a webmcp_predictions_v1 JSON artifact.',
  ].join('\n');
}

function parseCliOptions(args) {
  if (args.length % 2 !== 0) throw new WebMcpEvalError(usage());
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if ((flag !== '--fixture' && flag !== '--predictions') || !value || value.startsWith('--')) {
      throw new WebMcpEvalError(usage());
    }
    if (options.has(flag)) throw new WebMcpEvalError(`duplicate option: ${flag}`);
    options.set(flag, value);
  }
  return options;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WebMcpEvalError(`${label}: ${message}`);
  }
}

export function runWebMcpEvalCli(args) {
  try {
    if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
      return { stdout: `${usage()}\n`, stderr: '', exitCode: 0 };
    }
    const options = parseCliOptions(args);
    const fixturePath = resolve(options.get('--fixture') ?? DEFAULT_FIXTURE_PATH);
    const fixture = readJson(fixturePath, 'fixture');
    const predictionsPath = options.get('--predictions');
    if (predictionsPath) {
      const report = scorePredictions(
        fixture,
        readJson(resolve(predictionsPath), 'predictions'),
      );
      return {
        stdout: `${JSON.stringify(report, null, 2)}\n`,
        stderr: '',
        exitCode: report.status === 'passed' ? 0 : 2,
      };
    }

    const coverage = validateEvalFixture(fixture);
    const report = {
      version: REPORT_VERSION,
      mode: 'validate',
      status: 'valid',
      ...coverage,
    };
    return {
      stdout: `${JSON.stringify(report, null, 2)}\n`,
      stderr: '',
      exitCode: 0,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { stdout: '', stderr: `${message}\n`, exitCode: 1 };
  }
}

const isDirectExecution = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectExecution) {
  const result = runWebMcpEvalCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
