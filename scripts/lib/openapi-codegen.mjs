// Shared helpers for the OpenAPI post-generation injectors
// (scripts/openapi-inject-*.mjs) and their contract tests. Single-sourcing the
// byte-faithful serializer, the gateway/entitlement source-of-truth parsers, and
// the public-gate registry here removes the copy-paste drift between injectors
// and — crucially — lets the tests import the SAME constants the injectors use
// instead of re-scraping the injector source with duplicate regexes (which could
// silently diverge). Pure node builtins only: this runs under plain `node` in the
// `make generate` codegen context, so it must not import any npm dependency; a
// relative import like this one adds zero deps and runs identically.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/lib/ -> repo root.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// ── Byte-faithful JSON serializer (matches protoc-gen-openapiv3 output) ──────
// Recursively sorted keys + Go-style escaping of < > & U+2028 U+2029, no
// trailing newline — reproduces the generator's bytes so injected diffs are
// additions-only.
export const sortRec = (x) =>
  Array.isArray(x)
    ? x.map(sortRec)
    : x && typeof x === 'object'
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sortRec(x[k])]))
      : x;

export const goEscape = (s) => {
  let r = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    r += c === 0x3c || c === 0x3e || c === 0x26 || c === 0x2028 || c === 0x2029
      ? '\\u' + c.toString(16).padStart(4, '0')
      : ch;
  }
  return r;
};

export const serialize = (obj) => goEscape(JSON.stringify(sortRec(obj)));

// Order-insensitive deep-equal (keys sorted before compare) so change detection
// is stable across the sort-on-write round-trip.
export const eq = (a, b) => JSON.stringify(sortRec(a)) === JSON.stringify(sortRec(b));

// Normalize a parameter name to a lookup key (strip separators, lowercase).
export const normalizeKey = (name = '') => String(name).replace(/[_\-\s]/g, '').toLowerCase();

// ── Shared decision-signal provenance schemas ────────────────────────────────
// Corridors and decision signals carry the same provenance contract. Keep the
// strict known-value vocabulary here so every OpenAPI injector publishes the
// same validation rules for that shared envelope.
function objectSchema(required, properties, additionalProperties = false) {
  return {
    type: 'object',
    additionalProperties,
    required,
    properties,
  };
}

export const nonEmptyStringSchema = {
  type: 'string',
  minLength: 1,
  pattern: '\\S',
};
const calendarDayPattern = '(?:(?:\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|02-(?:0[1-9]|1\\d|2[0-8])))|(?:(?:\\d{2}(?:0[48]|[2468][048]|[13579][26])|(?:00|0[48]|[2468][048]|[13579][26])00)-02-29))';
const calendarDaySchema = {
  type: 'string',
  format: 'date',
  pattern: `^${calendarDayPattern}$`,
};
const calendarMonthSchema = {
  type: 'string',
  pattern: '^\\d{4}-(?:0[1-9]|1[0-2])$',
};
const calendarYearSchema = {
  type: 'string',
  pattern: '^\\d{4}$',
};
const isoInstantSchema = {
  type: 'string',
  format: 'date-time',
  pattern: `^${calendarDayPattern}T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{1,3})?Z$`,
};
export const provenanceTimestampSchema = {
  oneOf: [
    isoInstantSchema,
    calendarDaySchema,
    calendarMonthSchema,
    calendarYearSchema,
  ],
};
export const credentialFreeHttpsUrlSchema = {
  type: 'string',
  format: 'uri',
  pattern: '^https://(?![^/?#]*@)[^/?#\\s]+(?:[/?#]\\S*)?$',
};

function arrayOfNonEmptyStrings({ minItems, uniqueItems = false } = {}) {
  return {
    type: 'array',
    ...(minItems === undefined ? {} : { minItems }),
    uniqueItems,
    items: nonEmptyStringSchema,
  };
}

export function provenanceValueSchema(dimension, provenanceContract) {
  const timeRoles = {
    observation_time: 'observation',
    effective_time: 'effective',
    publication_time: 'publication',
    retrieval_time: 'retrieval',
  };
  if (dimension === 'publisher') {
    const registryReference = objectSchema(
      ['sourceName', 'sourceType', 'propagandaRisk'],
      {
        sourceName: nonEmptyStringSchema,
        sourceType: nonEmptyStringSchema,
        propagandaRisk: nonEmptyStringSchema,
      },
    );
    return {
      ...objectSchema(
        ['id', 'name', 'type', 'registryReference'],
        {
          id: nonEmptyStringSchema,
          name: nonEmptyStringSchema,
          type: { type: 'string', enum: provenanceContract.publisherTypes },
          registryReference: {
            oneOf: [registryReference, { type: 'null' }],
          },
        },
      ),
      oneOf: [
        {
          properties: {
            type: { const: 'derived_output' },
            registryReference: { type: 'null' },
          },
        },
        {
          properties: {
            type: {
              enum: provenanceContract.publisherTypes.filter(
                (type) => type !== 'derived_output',
              ),
            },
            registryReference,
          },
        },
      ],
    };
  }
  if (dimension === 'source_url') {
    return credentialFreeHttpsUrlSchema;
  }
  if (dimension === 'original_reference') {
    return objectSchema(
      ['kind', 'id'],
      {
        kind: {
          type: 'string',
          enum: provenanceContract.originalReferenceKinds,
        },
        id: nonEmptyStringSchema,
        contentHash: {
          type: 'string',
          pattern: '^sha256:[a-f0-9]{64}$',
        },
      },
    );
  }
  if (dimension === 'original_language') return nonEmptyStringSchema;
  if (dimension === 'translation') {
    return {
      ...objectSchema(
        ['state'],
        {
          state: {
            type: 'string',
            enum: provenanceContract.translationStates,
          },
          targetLanguage: nonEmptyStringSchema,
        },
      ),
      oneOf: [
        {
          properties: {
            state: { enum: ['machine_assisted', 'human_reviewed'] },
          },
          required: ['targetLanguage'],
        },
        {
          properties: {
            state: { enum: ['unavailable', 'not_translated'] },
          },
          not: { required: ['targetLanguage'] },
        },
      ],
    };
  }
  if (dimension in timeRoles) {
    return {
      ...objectSchema(
        ['role', 'value', 'precision'],
        {
          role: { type: 'string', const: timeRoles[dimension] },
          value: provenanceTimestampSchema,
          precision: {
            type: 'string',
            enum: provenanceContract.timePrecisions,
          },
        },
      ),
      oneOf: [
        {
          properties: {
            precision: { const: 'instant' },
            value: isoInstantSchema,
          },
        },
        {
          properties: {
            precision: { const: 'day' },
            value: calendarDaySchema,
          },
        },
        {
          properties: {
            precision: { const: 'month' },
            value: calendarMonthSchema,
          },
        },
        {
          properties: {
            precision: { const: 'year' },
            value: calendarYearSchema,
          },
        },
      ],
    };
  }
  if (dimension === 'revision') {
    return {
      ...objectSchema(
        ['vintageId', 'sequence', 'state'],
        {
          vintageId: nonEmptyStringSchema,
          sequence: { type: 'integer', minimum: 1 },
          state: {
            type: 'string',
            enum: provenanceContract.revisionStates,
          },
        },
      ),
      oneOf: [
        {
          properties: {
            state: { enum: ['preliminary', 'original'] },
            sequence: { const: 1 },
          },
        },
        {
          properties: {
            state: { enum: ['revised', 'corrected'] },
            sequence: { type: 'integer', minimum: 2 },
          },
        },
      ],
    };
  }
  if (dimension === 'supersession') {
    return {
      ...objectSchema(
        ['state'],
        {
          state: {
            type: 'string',
            enum: provenanceContract.supersessionStates,
          },
          relatedSignalId: nonEmptyStringSchema,
          reason: nonEmptyStringSchema,
        },
      ),
      oneOf: [
        {
          properties: { state: { const: 'current' } },
          not: {
            anyOf: [
              { required: ['relatedSignalId'] },
              { required: ['reason'] },
            ],
          },
        },
        {
          properties: { state: { enum: ['corrected', 'superseded'] } },
          required: ['relatedSignalId'],
        },
        {
          properties: { state: { const: 'cancelled' } },
          required: ['reason'],
        },
      ],
    };
  }
  if (
    dimension === 'extraction_confidence'
    || dimension === 'classification_confidence'
  ) {
    return objectSchema(
      ['score', 'method'],
      {
        score: { type: 'number', minimum: 0, maximum: 1 },
        method: nonEmptyStringSchema,
      },
    );
  }
  if (dimension === 'corroboration') {
    return {
      ...objectSchema(
        ['state', 'sourceSignalIds'],
        {
          state: {
            type: 'string',
            enum: provenanceContract.corroborationStates,
          },
          sourceSignalIds: arrayOfNonEmptyStrings({ uniqueItems: true }),
        },
      ),
      oneOf: [
        {
          properties: {
            state: { const: 'single_source' },
            sourceSignalIds: {
              ...arrayOfNonEmptyStrings({ uniqueItems: true }),
              minItems: 1,
              maxItems: 1,
            },
          },
        },
        {
          properties: {
            state: {
              enum: [
                'multi_source',
                'independently_corroborated',
                'contradicted',
              ],
            },
            sourceSignalIds: arrayOfNonEmptyStrings({
              minItems: 2,
              uniqueItems: true,
            }),
          },
        },
      ],
    };
  }
  if (dimension === 'transport_freshness') {
    return objectSchema(
      ['state', 'assessedAt'],
      {
        state: {
          type: 'string',
          enum: provenanceContract.transportFreshnessStates,
        },
        assessedAt: isoInstantSchema,
        lastSuccessAt: isoInstantSchema,
      },
    );
  }
  if (dimension === 'content_freshness') {
    return {
      ...objectSchema(
        ['state', 'assessedAt'],
        {
          state: {
            type: 'string',
            enum: provenanceContract.contentFreshnessStates,
          },
          assessedAt: isoInstantSchema,
          contentAsOf: provenanceTimestampSchema,
        },
      ),
      oneOf: [
        {
          properties: { state: { enum: ['current', 'stale'] } },
          required: ['contentAsOf'],
        },
        {
          properties: { state: { const: 'timestamp_unknown' } },
          not: { required: ['contentAsOf'] },
        },
        {
          properties: { state: { enum: ['unavailable', 'partial'] } },
        },
      ],
    };
  }
  if (dimension === 'derivation') {
    return objectSchema(
      ['methodId', 'methodVersion', 'computedAt', 'inputSignalIds'],
      {
        methodId: nonEmptyStringSchema,
        methodVersion: nonEmptyStringSchema,
        computedAt: isoInstantSchema,
        inputSignalIds: arrayOfNonEmptyStrings({
          minItems: 1,
          uniqueItems: true,
        }),
      },
    );
  }
  throw new Error(`No OpenAPI value schema for provenance dimension ${dimension}`);
}

// ── Source-of-truth parsers (fail-closed) ───────────────────────────────────
// Read the authoritative Set/Record literals straight from the gateway-adjacent
// TypeScript so the published auth contract can never drift from runtime. Each
// throws on a full parse miss or empty set — a rename can't silently mislabel
// auth (the caller adds a further non-empty guard on the union).
export function readPublicNoAuthPaths() {
  const src = readFileSync(resolve(root, 'server/gateway.ts'), 'utf8');
  const block = src.match(/PUBLIC_NO_AUTH_RPC_PATHS\s*=\s*new Set<string>\(\[([\s\S]*?)\]\)/);
  if (!block) throw new Error('could not locate PUBLIC_NO_AUTH_RPC_PATHS in server/gateway.ts');
  const paths = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (paths.length === 0) throw new Error('PUBLIC_NO_AUTH_RPC_PATHS parsed as empty — refusing to run');
  return new Set(paths);
}

export function readEndpointEntitlements() {
  const src = readFileSync(resolve(root, 'server/_shared/entitlement-check.ts'), 'utf8');
  const block = src.match(/ENDPOINT_ENTITLEMENTS\s*:\s*Record<string,\s*number>\s*=\s*\{([\s\S]*?)\};/);
  if (!block) throw new Error('could not locate ENDPOINT_ENTITLEMENTS in server/_shared/entitlement-check.ts');
  const entries = [...block[1].matchAll(/'([^']+)'\s*:\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]);
  if (entries.length === 0) throw new Error('ENDPOINT_ENTITLEMENTS parsed as empty — refusing to run');
  return new Map(entries);
}

export function readPremiumRpcPaths() {
  const src = readFileSync(resolve(root, 'src/shared/premium-paths.ts'), 'utf8');
  const block = src.match(/PREMIUM_RPC_PATHS\s*=\s*new Set<string>\(\[([\s\S]*?)\]\)/);
  if (!block) throw new Error('could not locate PREMIUM_RPC_PATHS in src/shared/premium-paths.ts');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

function readConstStringArray(src, name) {
  const block = src.match(new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`));
  return block ? [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]) : [];
}

export function readDecisionSignalProvenanceContract() {
  const src = readFileSync(resolve(root, 'shared/decision-signal-provenance-contract.ts'), 'utf8');
  const familySrc = readFileSync(
    resolve(root, 'shared/decision-signal-provenance-families.ts'),
    'utf8',
  );
  const version = src.match(
    /DECISION_SIGNAL_PROVENANCE_CONTRACT_VERSION\s*=\s*'([^']+)'\s+as const/,
  )?.[1];
  const dimensions = readConstStringArray(src, 'DECISION_SIGNAL_PROVENANCE_DIMENSIONS');
  const claimStatuses = readConstStringArray(src, 'DECISION_SIGNAL_PROVENANCE_CLAIM_STATUSES');
  const valueEnums = {
    publisherTypes: readConstStringArray(src, 'DECISION_SIGNAL_PUBLISHER_TYPES'),
    originalReferenceKinds: readConstStringArray(
      src,
      'DECISION_SIGNAL_ORIGINAL_REFERENCE_KINDS',
    ),
    translationStates: readConstStringArray(src, 'DECISION_SIGNAL_TRANSLATION_STATES'),
    timeRoles: readConstStringArray(src, 'DECISION_SIGNAL_TIME_ROLES'),
    timePrecisions: readConstStringArray(src, 'DECISION_SIGNAL_TIME_PRECISIONS'),
    revisionStates: readConstStringArray(src, 'DECISION_SIGNAL_REVISION_STATES'),
    supersessionStates: readConstStringArray(
      src,
      'DECISION_SIGNAL_SUPERSESSION_STATES',
    ),
    corroborationStates: readConstStringArray(
      src,
      'DECISION_SIGNAL_CORROBORATION_STATES',
    ),
    transportFreshnessStates: readConstStringArray(
      src,
      'DECISION_SIGNAL_TRANSPORT_FRESHNESS_STATES',
    ),
    contentFreshnessStates: readConstStringArray(
      src,
      'DECISION_SIGNAL_CONTENT_FRESHNESS_STATES',
    ),
  };
  const familyPolicies = Object.fromEntries(
    [...familySrc.matchAll(
      /^\s{2}([a-z0-9_]+): declaration\(\n\s{4}'([^']+)',[\s\S]*?\n\s{4}\{\n([\s\S]*?)\n\s{4}\},\n\s{2}\),/gm,
    )].map((match) => {
      const key = match[1];
      const id = match[2];
      if (key !== id) {
        throw new Error(`decision-signal provenance family key/id mismatch: ${key} != ${id}`);
      }
      const policies = Object.fromEntries(
        [...match[3].matchAll(/^\s{6}([a-z_]+): '(required|unknown_allowed|not_applicable)',?$/gm)]
          .map((policyMatch) => [policyMatch[1], policyMatch[2]]),
      );
      if (
        dimensions.some((dimension) => !(dimension in policies))
        || Object.keys(policies).length !== dimensions.length
      ) {
        throw new Error(`could not read all provenance policies for family ${id}`);
      }
      return [id, policies];
    }),
  );
  if (
    !version
    || dimensions.length === 0
    || claimStatuses.length === 0
    || Object.keys(familyPolicies).length === 0
    || Object.values(valueEnums).some((values) => values.length === 0)
  ) {
    throw new Error('could not read the decision-signal provenance contract');
  }
  return {
    version,
    dimensions,
    claimStatuses,
    familyPolicies,
    ...valueEnums,
  };
}

export function readChinaCorridorWireContract() {
  const corridor = readFileSync(
    resolve(root, 'shared/china-corridor-control-towers.ts'),
    'utf8',
  );
  const logistics = readFileSync(
    resolve(root, 'shared/china-logistics-corridors.ts'),
    'utf8',
  );
  const provenance = readFileSync(
    resolve(root, 'shared/decision-signal-provenance-contract.ts'),
    'utf8',
  );
  const contract = {
    availabilities: readConstStringArray(corridor, 'CHINA_CORRIDOR_AVAILABILITIES'),
    signalAvailabilities: readConstStringArray(
      corridor,
      'CHINA_CORRIDOR_SIGNAL_AVAILABILITIES',
    ),
    timePrecisions: readConstStringArray(corridor, 'CHINA_CORRIDOR_TIME_PRECISIONS'),
    publisherTypes: readConstStringArray(corridor, 'CHINA_CORRIDOR_PUBLISHER_TYPES'),
    sourceScopes: readConstStringArray(corridor, 'CHINA_CORRIDOR_SOURCE_SCOPES'),
    revisionStates: readConstStringArray(corridor, 'CHINA_CORRIDOR_REVISION_STATES'),
    corridorIds: readConstStringArray(logistics, 'CHINA_LOGISTICS_CORRIDOR_IDS'),
    signalFamilies: readConstStringArray(logistics, 'CHINA_CORRIDOR_SIGNAL_FAMILIES'),
    nodeTypes: readConstStringArray(logistics, 'CHINA_CORRIDOR_NODE_TYPES'),
    transportFreshnessStates: readConstStringArray(
      provenance,
      'DECISION_SIGNAL_TRANSPORT_FRESHNESS_STATES',
    ),
    contentFreshnessStates: readConstStringArray(
      provenance,
      'DECISION_SIGNAL_CONTENT_FRESHNESS_STATES',
    ),
  };
  if (Object.values(contract).some((values) => values.length === 0)) {
    throw new Error('could not read the China corridor wire contract');
  }
  return contract;
}

export function readChinaDecisionSignalWireContract() {
  const src = readFileSync(
    resolve(root, 'shared/china-decision-signals.ts'),
    'utf8',
  );
  const manifestSrc = readFileSync(
    resolve(root, 'shared/china-decision-signal-manifest.ts'),
    'utf8',
  );
  const manifestBlock = manifestSrc.match(
    /CHINA_DECISION_SIGNAL_GROUP_MANIFEST\s*=\s*\[([\s\S]*?)\]\s*as const/,
  )?.[1];
  const groupManifest = manifestBlock
    ? [...manifestBlock.matchAll(
        /\{\s*groupId:\s*'([^']+)',\s*provenanceFamily:\s*'([^']+)',\s*sourceKey:\s*'([^']+)',\s*\}/g,
      )].map((match) => ({
        groupId: match[1],
        provenanceFamily: match[2],
        sourceKey: match[3],
      }))
    : [];
  const manifestEntryCount = manifestBlock
    ? [...manifestBlock.matchAll(/\{\s*groupId:/g)].length
    : 0;
  const maxItemsMatches = [...manifestSrc.matchAll(
    /CHINA_DECISION_SIGNAL_MAX_ITEMS_PER_GROUP\s*=\s*(\d+)\s+as const/g,
  )];
  const schemaVersion = Number(src.match(
    /CHINA_DECISION_SIGNAL_SCHEMA_VERSION\s*=\s*(\d+)\s+as const/,
  )?.[1]);
  const groupIds = groupManifest.map(({ groupId }) => groupId);
  const provenanceFamilyIds = groupManifest.map(
    ({ provenanceFamily }) => provenanceFamily,
  );
  const stateBlock = src.match(
    /export type ChinaDecisionSignalState\s*=\s*([\s\S]*?);/,
  )?.[1];
  const states = stateBlock
    ? [...stateBlock.matchAll(/'([^']+)'/g)].map((match) => match[1])
    : [];
  const accessBlock = src.match(
    /access:\s*\{([\s\S]*?)\};\s*\}/,
  )?.[1];
  const access = Object.fromEntries(
    accessBlock
      ? [...accessBlock.matchAll(/\b(anonymous|pro|operator):\s*'([^']+)'/g)]
        .map((match) => [match[1], match[2]])
      : [],
  );
  const maxItemsPerGroup = Number(maxItemsMatches[0]?.[1]);
  const provenanceFamilies = new Set(
    Object.keys(readDecisionSignalProvenanceContract().familyPolicies),
  );
  if (
    !Number.isInteger(schemaVersion)
    || schemaVersion < 1
    || groupIds.length === 0
    || manifestEntryCount !== groupManifest.length
    || new Set(groupIds).size !== groupIds.length
    || new Set(provenanceFamilyIds).size !== provenanceFamilyIds.length
    || new Set(groupManifest.map(({ sourceKey }) => sourceKey)).size !== groupManifest.length
    || provenanceFamilyIds.some((familyId) => !provenanceFamilies.has(familyId))
    || states.length === 0
    || Object.keys(access).length !== 3
    || maxItemsMatches.length !== 1
    || !Number.isInteger(maxItemsPerGroup)
    || maxItemsPerGroup < 1
  ) {
    throw new Error('could not read the China decision-signal wire contract');
  }
  return {
    schemaVersion,
    groupManifest,
    groupIds,
    provenanceFamilyIds,
    states,
    access,
    maxItemsPerGroup,
  };
}

// ── Public 403 gates ─────────────────────────────────────────────────────────
// Public RPCs (security: []) that nonetheless document a 403 the handler throws.
// Lead capture opts out of API-key auth at the gateway, then fails closed in the
// handler on a Turnstile / desktop-auth failure. Single-sourced here so the
// contract test asserts specs against the SAME map the injector stamps from.
export const PUBLIC_FORBIDDEN_GATES = new Map([
  ['/api/leads/v1/submit-contact', {
    note: 'Turnstile-gated. Missing or invalid Cloudflare Turnstile token returns 403 Bot verification failed.',
    response: {
      description: 'Bot verification failed.',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/Error' },
        },
      },
    },
  }],
  ['/api/leads/v1/register-interest', {
    // The handler (server/worldmonitor/leads/v1/register-interest.ts) fails
    // closed with two distinct 403s: browser callers that fail the Cloudflare
    // Turnstile check get 403 Bot verification failed; desktop-source callers
    // whose shared-secret HMAC bypass is missing/invalid get 403 Desktop
    // authentication failed. Both are thrown as the sebuf ApiError, so the body
    // is the generated Error schema (a `message` string) — same shape the
    // submit-contact gate documents.
    note: 'Turnstile-gated (desktop sources authenticate a bypass with a shared-secret HMAC instead). A failed Cloudflare Turnstile check returns 403 Bot verification failed; a desktop-source request with a missing or invalid HMAC signature returns 403 Desktop authentication failed.',
    response: {
      description: 'Bot verification or desktop authentication failed.',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/Error' },
        },
      },
    },
  }],
]);
