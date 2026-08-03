#!/usr/bin/env node
/**
 * Documents the canonical JSON carried by GetChinaDecisionSignals.
 *
 * The RPC keeps payloadJson as a string so the bounded provenance-preserving
 * snapshot crosses the API, country summary, and MCP surfaces byte-for-byte.
 * OpenAPI 3.1 can still expose the embedded contract through
 * contentMediaType/contentSchema. This injector restores those annotations and
 * a deterministic six-group response example after sebuf regeneration.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  credentialFreeHttpsUrlSchema as credentialFreeHttpsUrl,
  nonEmptyStringSchema as nonEmptyString,
  provenanceTimestampSchema as provenanceTimestamp,
  provenanceValueSchema,
  readChinaDecisionSignalWireContract,
  readDecisionSignalProvenanceContract,
  readPublicNoAuthPaths,
  serialize,
  sortRec,
} from './lib/openapi-codegen.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');
const CHECK = process.argv.includes('--check');
const RPC_PATH = '/api/intelligence/v1/get-china-decision-signals';
const wireContract = readChinaDecisionSignalWireContract();
const provenanceContract = readDecisionSignalProvenanceContract();
const nonKnownClaimStatuses = provenanceContract.claimStatuses.filter(
  (status) => status !== 'known',
);

if (!readPublicNoAuthPaths().has(RPC_PATH)) {
  throw new Error(`${RPC_PATH} is not registered as a public no-auth RPC`);
}

const targets = [
  {
    path: resolve(apiDir, 'IntelligenceService.openapi.json'),
    format: 'json',
    envelope: 'GetChinaDecisionSignalsResponse',
    prefix: '',
  },
  {
    path: resolve(apiDir, 'IntelligenceService.openapi.yaml'),
    format: 'yaml',
    envelope: 'GetChinaDecisionSignalsResponse',
    prefix: '',
  },
  {
    path: resolve(apiDir, 'worldmonitor.openapi.yaml'),
    format: 'yaml',
    envelope: 'worldmonitor_intelligence_v1_GetChinaDecisionSignalsResponse',
    prefix: 'worldmonitor_intelligence_v1_',
  },
];

const schemaNames = (prefix) => ({
  snapshot: `${prefix}ChinaDecisionSignalSnapshot`,
  access: `${prefix}ChinaDecisionSignalAccess`,
  group: `${prefix}ChinaDecisionSignalGroup`,
  item: `${prefix}ChinaDecisionSignalItem`,
  provenance: `${prefix}ChinaDecisionSignalProvenance`,
  claims: `${prefix}ChinaDecisionSignalProvenanceClaims`,
  unavailableClaim: `${prefix}ChinaDecisionSignalUnavailableClaim`,
});

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

function objectSchema(required, properties, additionalProperties = false) {
  return {
    type: 'object',
    additionalProperties,
    required,
    properties,
  };
}

function nullable(schema) {
  return {
    oneOf: [schema, { type: 'null' }],
  };
}

function schemas(prefix) {
  const names = schemaNames(prefix);
  const unavailableClaim = objectSchema(
    ['status', 'reason'],
    {
      status: {
        type: 'string',
        enum: nonKnownClaimStatuses,
      },
      reason: nonEmptyString,
    },
  );
  const claimFor = (dimension) => ({
    oneOf: [
      objectSchema(
        ['status', 'value'],
        {
          status: { type: 'string', const: 'known' },
          value: provenanceValueSchema(dimension, provenanceContract),
        },
      ),
      ref(names.unavailableClaim),
    ],
  });
  return {
    [names.snapshot]: objectSchema(
      ['schemaVersion', 'generatedAt', 'groups', 'access'],
      {
        schemaVersion: {
          type: 'integer',
          const: wireContract.schemaVersion,
        },
        generatedAt: { type: 'string', format: 'date-time' },
        groups: {
          type: 'array',
          minItems: wireContract.groupIds.length,
          maxItems: wireContract.groupIds.length,
          prefixItems: wireContract.groupIds.map((id) => ({
            allOf: [
              ref(names.group),
              {
                type: 'object',
                properties: { id: { const: id } },
              },
            ],
          })),
          items: false,
        },
        access: ref(names.access),
      },
    ),
    [names.access]: objectSchema(
      ['anonymous', 'pro', 'operator'],
      {
        anonymous: {
          type: 'string',
          const: wireContract.access.anonymous,
        },
        pro: {
          type: 'string',
          const: wireContract.access.pro,
        },
        operator: {
          type: 'string',
          const: wireContract.access.operator,
        },
      },
    ),
    [names.group]: {
      ...objectSchema(
        ['id', 'state', 'reason', 'items', 'metadata'],
        {
          id: {
            type: 'string',
            enum: wireContract.groupIds,
          },
          state: {
            type: 'string',
            enum: wireContract.states,
          },
          reason: nullable(nonEmptyString),
          items: {
            type: 'array',
            maxItems: wireContract.maxItemsPerGroup,
            items: ref(names.item),
          },
          metadata: {
            type: 'object',
            additionalProperties: true,
          },
        },
      ),
      oneOf: [
        {
          properties: {
            state: { const: 'unavailable' },
            items: { type: 'array', maxItems: 0 },
          },
        },
        {
          properties: {
            state: {
              enum: wireContract.states.filter(
                (state) => state !== 'unavailable',
              ),
            },
            items: {
              type: 'array',
              minItems: 1,
              maxItems: wireContract.maxItemsPerGroup,
            },
          },
        },
      ],
    },
    [names.item]: objectSchema(
      [
        'id',
        'lineageId',
        'label',
        'summary',
        'sourceName',
        'sourceUrl',
        'publisherType',
        'observedAt',
        'publishedAt',
        'effectiveAt',
        'retrievedAt',
        'stale',
        'metadata',
        'provenance',
      ],
      {
        id: nonEmptyString,
        lineageId: nonEmptyString,
        label: nonEmptyString,
        summary: nonEmptyString,
        sourceName: nonEmptyString,
        sourceUrl: nullable(credentialFreeHttpsUrl),
        publisherType: {
          type: 'string',
          enum: provenanceContract.publisherTypes,
        },
        observedAt: nullable(provenanceTimestamp),
        publishedAt: nullable(provenanceTimestamp),
        effectiveAt: nullable(provenanceTimestamp),
        retrievedAt: nullable(provenanceTimestamp),
        stale: { type: 'boolean' },
        metadata: {
          type: 'object',
          additionalProperties: true,
        },
        provenance: ref(names.provenance),
      },
    ),
    [names.provenance]: {
      ...objectSchema(
        ['contractVersion', 'signalId', 'familyId', 'claims'],
        {
          contractVersion: {
            type: 'string',
            const: provenanceContract.version,
          },
          signalId: nonEmptyString,
          familyId: {
            type: 'string',
            enum: wireContract.provenanceFamilyIds,
          },
          claims: ref(names.claims),
        },
      ),
      oneOf: wireContract.provenanceFamilyIds.map((familyId) => {
        const policies = provenanceContract.familyPolicies[familyId];
        if (!policies) {
          throw new Error(`No provenance declaration policy for family ${familyId}`);
        }
        return {
          properties: {
            familyId: { const: familyId },
            claims: {
              type: 'object',
              properties: Object.fromEntries(
                provenanceContract.dimensions.map((dimension) => {
                  const policy = policies[dimension];
                  const allowedStatuses = policy === 'required'
                    ? ['known']
                    : policy === 'not_applicable'
                      ? ['not_applicable']
                      : ['known', 'unknown'];
                  return [
                    dimension,
                    {
                      type: 'object',
                      properties: {
                        status: { enum: allowedStatuses },
                      },
                    },
                  ];
                }),
              ),
            },
          },
        };
      }),
    },
    [names.claims]: objectSchema(
      provenanceContract.dimensions,
      Object.fromEntries(
        provenanceContract.dimensions.map((dimension) => [
          dimension,
          claimFor(dimension),
        ]),
      ),
    ),
    [names.unavailableClaim]: unavailableClaim,
  };
}

function responseExample() {
  const generatedAt = '2026-07-26T12:00:00.000Z';
  const payload = {
    schemaVersion: wireContract.schemaVersion,
    generatedAt,
    groups: wireContract.groupIds.map((id) => ({
      id,
      state: 'unavailable',
      reason: 'No launched, provenance-valid signal is currently available.',
      items: [],
      metadata: {
        totalValidItems: 0,
        omittedItemCount: 0,
      },
    })),
    access: { ...wireContract.access },
  };
  return {
    payloadJson: JSON.stringify(payload),
    generatedAt,
    upstreamUnavailable: true,
  };
}

function injectObject(spec, envelopeName, prefix) {
  Object.assign(spec.components.schemas, schemas(prefix));
  const payloadJson = spec.components.schemas[envelopeName].properties.payloadJson;
  spec.components.schemas[envelopeName].properties.payloadJson = {
    ...payloadJson,
    contentMediaType: 'application/json',
    contentSchema: ref(schemaNames(prefix).snapshot),
  };
  const operation = spec.paths[RPC_PATH].get;
  operation.security = [];
  operation.responses['200'].content['application/json'].example = responseExample();
}

function yamlScalar(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  throw new Error(`Unsupported YAML scalar: ${String(value)}`);
}

function yamlKey(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? value : JSON.stringify(value);
}

function renderYaml(value, indent) {
  const prefix = ' '.repeat(indent);
  if (value === null || typeof value !== 'object') return [`${prefix}${yamlScalar(value)}`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${prefix}[]`];
    return value.flatMap((item) => {
      if (item === null || typeof item !== 'object') return [`${prefix}- ${yamlScalar(item)}`];
      return [`${prefix}-`, ...renderYaml(item, indent + 4)];
    });
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return [`${prefix}{}`];
  return entries.flatMap(([key, child]) => {
    if (child === null || typeof child !== 'object') {
      return [`${prefix}${yamlKey(key)}: ${yamlScalar(child)}`];
    }
    return [`${prefix}${yamlKey(key)}:`, ...renderYaml(child, indent + 4)];
  });
}

function renderResponseExample(indent) {
  const prefix = ' '.repeat(indent);
  return Object.entries(sortRec(responseExample())).map(
    ([key, value]) => `${prefix}${JSON.stringify(key)}: ${yamlScalar(value)}`,
  );
}

function indentOf(line) {
  return line.match(/^ */)?.[0].length ?? 0;
}

function blockEnd(lines, start, indent) {
  let index = start + 1;
  while (index < lines.length) {
    if (lines[index].trim() && indentOf(lines[index]) <= indent) break;
    index++;
  }
  return index;
}

function injectYaml(raw, envelopeName, prefix) {
  const lines = raw.split('\n');
  const desiredSchemas = schemas(prefix);
  for (const name of Object.keys(desiredSchemas)) {
    const index = lines.findIndex((line) =>
      indentOf(line) === 8 && line.trim() === `${name}:`);
    if (index !== -1) lines.splice(index, blockEnd(lines, index, 8) - index);
  }
  const schemasIndex = lines.indexOf('    schemas:');
  if (schemasIndex === -1) throw new Error('OpenAPI YAML is missing components.schemas');
  const renderedSchemas = Object.entries(desiredSchemas).flatMap(([name, schema]) => [
    `        ${name}:`,
    ...renderYaml(schema, 12),
  ]);
  // The corridor injector owns the first China schema block and expects it to
  // remain there on idempotence checks. Place this independent contract after
  // any corridor schemas so running the two injectors cannot ping-pong YAML.
  let insertAt = schemasIndex + 1;
  while (
    insertAt < lines.length
    && indentOf(lines[insertAt]) === 8
    && /ChinaCorridor/.test(lines[insertAt])
  ) {
    insertAt = blockEnd(lines, insertAt, 8);
  }
  lines.splice(insertAt, 0, ...renderedSchemas);

  const envelopeIndex = lines.findIndex((line) =>
    indentOf(line) === 8 && line.trim() === `${envelopeName}:`);
  if (envelopeIndex === -1) throw new Error(`OpenAPI YAML is missing ${envelopeName}`);
  const envelopeEnd = blockEnd(lines, envelopeIndex, 8);
  const payloadIndex = lines.findIndex((line, index) =>
    index > envelopeIndex
    && index < envelopeEnd
    && indentOf(line) === 16
    && line.trim() === 'payloadJson:');
  if (payloadIndex === -1) throw new Error(`${envelopeName} is missing payloadJson`);
  let payloadEnd = blockEnd(lines, payloadIndex, 16);
  for (let index = payloadIndex + 1; index < payloadEnd;) {
    if (
      indentOf(lines[index]) === 20
      && (
        lines[index].trim().startsWith('contentMediaType:')
        || lines[index].trim() === 'contentSchema:'
      )
    ) {
      const end = blockEnd(lines, index, 20);
      lines.splice(index, end - index);
      payloadEnd -= end - index;
      continue;
    }
    index++;
  }
  lines.splice(
    payloadIndex + 1,
    0,
    '                    contentMediaType: "application/json"',
    '                    contentSchema:',
    `                        $ref: "#/components/schemas/${schemaNames(prefix).snapshot}"`,
  );

  const pathIndex = lines.indexOf(`    ${RPC_PATH}:`);
  if (pathIndex === -1) throw new Error(`OpenAPI YAML is missing ${RPC_PATH}`);
  const pathEnd = blockEnd(lines, pathIndex, 4);
  const getIndex = lines.findIndex((line, index) =>
    index > pathIndex
    && index < pathEnd
    && indentOf(line) === 8
    && line.trim() === 'get:');
  if (getIndex === -1) throw new Error(`${RPC_PATH} is missing its GET operation`);
  const operationEnd = blockEnd(lines, getIndex, 8);
  const securityIndex = lines.findIndex((line, index) =>
    index > getIndex
    && index < operationEnd
    && indentOf(line) === 12
    && line.trim().startsWith('security:'));
  if (securityIndex !== -1) {
    lines.splice(
      securityIndex,
      blockEnd(lines, securityIndex, 12) - securityIndex,
    );
  }
  lines.splice(getIndex + 1, 0, '            security: []');

  const updatedPathIndex = lines.indexOf(`    ${RPC_PATH}:`);
  const updatedPathEnd = blockEnd(lines, updatedPathIndex, 4);
  const mediaIndex = lines.findIndex((line, index) =>
    index > updatedPathIndex
    && index < updatedPathEnd
    && indentOf(line) === 24
    && line.trim() === 'application/json:');
  if (mediaIndex === -1) throw new Error(`${RPC_PATH} is missing its JSON response`);
  let mediaEnd = blockEnd(lines, mediaIndex, 24);
  for (let index = mediaIndex + 1; index < mediaEnd;) {
    if (indentOf(lines[index]) === 28 && lines[index].trim() === 'example:') {
      const end = blockEnd(lines, index, 28);
      lines.splice(index, end - index);
      mediaEnd -= end - index;
      continue;
    }
    index++;
  }
  lines.splice(
    mediaIndex + 1,
    0,
    '                            example:',
    ...renderResponseExample(32),
  );
  return lines.join('\n');
}

let changed = 0;
for (const target of targets) {
  const raw = readFileSync(target.path, 'utf8');
  let output;
  if (target.format === 'json') {
    const spec = JSON.parse(raw);
    injectObject(spec, target.envelope, target.prefix);
    output = serialize(spec);
  } else {
    output = injectYaml(raw, target.envelope, target.prefix);
  }
  if (output === raw) continue;
  changed++;
  if (!CHECK) writeFileSync(target.path, output);
}

if (CHECK && changed > 0) {
  console.error(`x ${changed} OpenAPI artifact(s) missing the China decision-signal JSON contract`);
  console.error('  Run: node scripts/openapi-inject-china-decision-signals.mjs');
  process.exit(1);
}

console.log(
  CHECK
    ? 'ok China decision-signal JSON contract is present in every OpenAPI artifact'
    : `openapi-inject-china-decision-signals: updated ${changed} artifact(s)`,
);
