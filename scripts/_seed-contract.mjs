// Seed contract validators.
//
// See docs/plans/2026-04-14-002-fix-runseed-zero-record-lockout-plan.md.
//
// In PR 1 these validators are imported but not yet invoked by `runSeed` — the
// conformance test (tests/seed-contract.test.mjs) soft-warns on violations
// without failing CI. PR 2 wires `validateDescriptor()` into `runSeed()` so the
// contract is enforced at runtime. PR 3 hard-fails the conformance test.

export class SeedContractError extends Error {
  constructor(message, { descriptor, field } = {}) {
    super(message);
    this.name = 'SeedContractError';
    this.descriptor = descriptor;
    this.field = field;
  }
}

const REQUIRED_FIELDS = [
  'domain',
  'resource',
  'canonicalKey',
  'fetchFn',
  'validateFn',
  'declareRecords',
  'ttlSeconds',
  'sourceVersion',
  'schemaVersion',
  'maxStaleMin',
];

const OPTIONAL_FIELDS = new Set([
  'lockTtlMs',
  'extraKeys',
  'afterPublish',
  'publishTransform',
  'emptyDataIsFailure',
  'zeroIsValid',
  'populationMode',
  'cascadeGroup',
  'groupMembers',
  'recordCount', // legacy — kept optional through PR 2, removed in PR 3 in favor of declareRecords
]);

/**
 * Validate that a descriptor passed to `runSeed()` satisfies the contract.
 *
 * Throws `SeedContractError` with a specific `field` on the first violation.
 * Returns the descriptor unchanged on success.
 */
export function validateDescriptor(descriptor) {
  if (descriptor == null || typeof descriptor !== 'object') {
    throw new SeedContractError('runSeed descriptor must be an object', { descriptor });
  }

  for (const field of REQUIRED_FIELDS) {
    if (descriptor[field] == null) {
      throw new SeedContractError(`runSeed descriptor missing required field: ${field}`, { descriptor, field });
    }
  }

  const checks = [
    ['domain', 'string'],
    ['resource', 'string'],
    ['canonicalKey', 'string'],
    ['fetchFn', 'function'],
    ['validateFn', 'function'],
    ['declareRecords', 'function'],
    ['ttlSeconds', 'number'],
    ['sourceVersion', 'string'],
    ['schemaVersion', 'number'],
    ['maxStaleMin', 'number'],
  ];
  for (const [field, expected] of checks) {
    const actual = typeof descriptor[field];
    if (actual !== expected) {
      throw new SeedContractError(
        `runSeed descriptor field "${field}" must be ${expected}, got ${actual}`,
        { descriptor, field }
      );
    }
  }

  if (descriptor.ttlSeconds <= 0) {
    throw new SeedContractError('runSeed descriptor ttlSeconds must be > 0', { descriptor, field: 'ttlSeconds' });
  }
  if (!Number.isInteger(descriptor.schemaVersion) || descriptor.schemaVersion < 1) {
    throw new SeedContractError('runSeed descriptor schemaVersion must be a positive integer', { descriptor, field: 'schemaVersion' });
  }
  if (descriptor.maxStaleMin <= 0) {
    throw new SeedContractError('runSeed descriptor maxStaleMin must be > 0', { descriptor, field: 'maxStaleMin' });
  }

  if (descriptor.populationMode != null && descriptor.populationMode !== 'scheduled' && descriptor.populationMode !== 'on_demand') {
    throw new SeedContractError(
      `runSeed descriptor populationMode must be 'scheduled' or 'on_demand', got ${descriptor.populationMode}`,
      { descriptor, field: 'populationMode' }
    );
  }

  const known = new Set([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);
  for (const field of Object.keys(descriptor)) {
    if (!known.has(field)) {
      throw new SeedContractError(`runSeed descriptor has unknown field: ${field}`, { descriptor, field });
    }
  }

  return descriptor;
}

/**
 * Apply declareRecords to a payload and return a non-negative integer or throw.
 * Centralized so runSeed, tests, and any future tooling share the same rules.
 */
export function resolveRecordCount(declareRecords, data) {
  if (typeof declareRecords !== 'function') {
    throw new SeedContractError('declareRecords must be a function', { field: 'declareRecords' });
  }
  let count;
  try {
    count = declareRecords(data);
  } catch (err) {
    const wrapped = new SeedContractError(`declareRecords threw: ${err && err.message ? err.message : err}`, { field: 'declareRecords' });
    wrapped.cause = err;
    throw wrapped;
  }
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
    throw new SeedContractError(
      `declareRecords must return a non-negative integer, got ${JSON.stringify(count)}`,
      { field: 'declareRecords' }
    );
  }
  return count;
}

// Re-export envelope helpers so seeder code can import "everything contract-y"
// from one module. The single source of truth for the helpers themselves is
// scripts/_seed-envelope-source.mjs.
export { unwrapEnvelope, stripSeedEnvelope, buildEnvelope } from './_seed-envelope-source.mjs';
