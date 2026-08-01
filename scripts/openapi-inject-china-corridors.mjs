#!/usr/bin/env node
/**
 * Documents the canonical JSON carried by GetChinaCorridorControlTowers.
 *
 * The RPC deliberately keeps payloadJson as a string so the #5581 provenance
 * envelope crosses cache, API, UI, and future MCP surfaces byte-for-byte.
 * OpenAPI 3.1 can still expose that inner JSON contract through
 * contentMediaType/contentSchema. This injector restores those annotations and
 * a representative response example after sebuf regeneration.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  provenanceValueSchema,
  readChinaCorridorWireContract,
  readDecisionSignalProvenanceContract,
  serialize,
  sortRec,
} from './lib/openapi-codegen.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');
const CHECK = process.argv.includes('--check');
const RPC_PATH = '/api/supply-chain/v1/get-china-corridor-control-towers';
const UPSTREAM_DESCRIPTION =
  'True only when every reviewed corridor is unavailable. Agents and API callers must treat true as upstream degradation, not as evidence that corridor conditions are normal or zero.';
const corridorContract = readChinaCorridorWireContract();
const provenanceContract = readDecisionSignalProvenanceContract();
const nonKnownClaimStatuses = provenanceContract.claimStatuses.filter(
  (status) => status !== 'known',
);

const targets = [
  {
    path: resolve(apiDir, 'SupplyChainService.openapi.json'),
    format: 'json',
    envelope: 'GetChinaCorridorControlTowersResponse',
    prefix: '',
  },
  {
    path: resolve(apiDir, 'SupplyChainService.openapi.yaml'),
    format: 'yaml',
    envelope: 'GetChinaCorridorControlTowersResponse',
    prefix: '',
  },
  {
    path: resolve(apiDir, 'worldmonitor.openapi.yaml'),
    format: 'yaml',
    envelope: 'worldmonitor_supply_chain_v1_GetChinaCorridorControlTowersResponse',
    prefix: 'worldmonitor_supply_chain_v1_',
  },
];

const schemaNames = (prefix) => ({
  response: `${prefix}ChinaCorridorControlTowerResponse`,
  corridor: `${prefix}ChinaCorridorControlTower`,
  condition: `${prefix}ChinaCorridorCondition`,
  provenance: `${prefix}ChinaCorridorProvenance`,
  claim: `${prefix}ChinaCorridorProvenanceClaim`,
});

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

function objectSchema(required, properties) {
  return {
    type: 'object',
    additionalProperties: false,
    required,
    properties,
  };
}

function provenanceClaimSchema(valueSchema, unavailableClaimName) {
  return {
    oneOf: [
      objectSchema(
        ['status', 'value'],
        {
          status: { type: 'string', const: 'known' },
          value: valueSchema,
        },
      ),
      ref(unavailableClaimName),
    ],
  };
}

function schemas(prefix) {
  const names = schemaNames(prefix);
  return {
    [names.response]: {
      type: 'object',
      description: 'Canonical transparent China logistics corridor composition decoded from payloadJson.',
      required: ['generatedAt', 'corridors'],
      properties: {
        generatedAt: { type: 'string', format: 'date-time' },
        corridors: { type: 'array', items: ref(names.corridor) },
      },
    },
    [names.corridor]: {
      type: 'object',
      required: ['id', 'name', 'description', 'boundary', 'nodes', 'availability', 'conditions'],
      properties: {
        id: {
          type: 'string',
          enum: corridorContract.corridorIds,
        },
        name: { type: 'string' },
        description: { type: 'string' },
        boundary: {
          type: 'array',
          items: {
            type: 'object',
            required: ['lat', 'lon'],
            properties: {
              lat: { type: 'number', format: 'double' },
              lon: { type: 'number', format: 'double' },
            },
          },
        },
        nodes: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'name', 'type', 'lat', 'lon', 'sourceOwner'],
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              type: { type: 'string', enum: corridorContract.nodeTypes },
              lat: { type: 'number', format: 'double' },
              lon: { type: 'number', format: 'double' },
              sourceOwner: { type: 'string' },
              sourceSelector: {
                type: 'object',
                required: ['family', 'id'],
                properties: {
                  family: {
                    type: 'string',
                    enum: corridorContract.signalFamilies,
                  },
                  id: { type: 'string' },
                },
              },
            },
          },
        },
        availability: { type: 'string', enum: corridorContract.availabilities },
        conditions: { type: 'array', items: ref(names.condition) },
      },
    },
    [names.condition]: {
      type: 'object',
      required: ['family', 'providerId', 'availability', 'reason', 'sourceSignals', 'provenance'],
      properties: {
        family: {
          type: 'string',
          enum: corridorContract.signalFamilies,
        },
        providerId: { type: 'string' },
        availability: { type: 'string', enum: corridorContract.availabilities },
        reason: { type: ['string', 'null'] },
        sourceSignals: {
          type: 'array',
          items: {
            type: 'object',
            required: [
              'id',
              'family',
              'selectorId',
              'availability',
              'publisher',
              'sourceUrl',
              'sourceScope',
              'observationTime',
              'observationTimePrecision',
              'releaseTime',
              'releaseTimePrecision',
              'retrievalTime',
              'retrievalTimePrecision',
              'revision',
              'transportFreshness',
              'contentFreshness',
              'summary',
              'metrics',
            ],
            properties: {
              id: { type: 'string' },
              family: {
                type: 'string',
                enum: corridorContract.signalFamilies,
              },
              selectorId: { type: 'string' },
              corridorIds: {
                type: 'array',
                items: {
                  type: 'string',
                  enum: corridorContract.corridorIds,
                },
              },
              availability: {
                type: 'string',
                enum: corridorContract.signalAvailabilities,
              },
              publisher: {
                type: 'object',
                required: ['id', 'name', 'type'],
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  type: {
                    type: 'string',
                    enum: corridorContract.publisherTypes,
                  },
                },
              },
              sourceUrl: { type: ['string', 'null'], format: 'uri' },
              sourceScope: { type: 'string', enum: corridorContract.sourceScopes },
              observationTime: { type: ['string', 'null'] },
              observationTimePrecision: {
                type: 'string',
                enum: corridorContract.timePrecisions,
              },
              releaseTime: { type: ['string', 'null'] },
              releaseTimePrecision: {
                type: 'string',
                enum: corridorContract.timePrecisions,
              },
              retrievalTime: { type: ['string', 'null'] },
              retrievalTimePrecision: {
                type: 'string',
                enum: corridorContract.timePrecisions,
              },
              revision: {
                oneOf: [
                  {
                    type: 'object',
                    required: ['vintageId', 'sequence', 'state'],
                    properties: {
                      vintageId: { type: 'string' },
                      sequence: { type: 'number' },
                      state: { type: 'string', enum: corridorContract.revisionStates },
                    },
                  },
                  { type: 'null' },
                ],
              },
              transportFreshness: {
                type: 'string',
                enum: corridorContract.transportFreshnessStates,
              },
              contentFreshness: {
                type: 'string',
                enum: corridorContract.contentFreshnessStates,
              },
              summary: { type: 'string' },
              metrics: {
                type: 'object',
                additionalProperties: {
                  type: ['string', 'number', 'boolean', 'null'],
                },
              },
            },
          },
        },
        provenance: {
          oneOf: [
            ref(names.provenance),
            { type: 'null' },
          ],
        },
      },
    },
    [names.provenance]: {
      type: 'object',
      description: 'The #5581 decision-signal provenance envelope retained for the composed condition.',
      required: ['contractVersion', 'signalId', 'familyId', 'claims'],
      properties: {
        contractVersion: { type: 'string', const: provenanceContract.version },
        signalId: { type: 'string' },
        familyId: { type: 'string', const: 'composed_corridor_condition' },
        claims: {
          type: 'object',
          required: provenanceContract.dimensions,
          properties: Object.fromEntries(
            provenanceContract.dimensions.map((name) => [
              name,
              provenanceClaimSchema(
                provenanceValueSchema(name, provenanceContract),
                names.claim,
              ),
            ]),
          ),
        },
      },
    },
    [names.claim]: {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'reason'],
      properties: {
        status: {
          type: 'string',
          enum: nonKnownClaimStatuses,
        },
        reason: { type: 'string' },
      },
    },
  };
}

function responseExample() {
  const payload = {
    generatedAt: '2026-07-25T12:00:00.000Z',
    corridors: [{
      id: 'china-yangtze-river-delta',
      name: 'Yangtze River Delta',
      description: 'Reviewed coastal logistics corridor joining Shanghai, Jiangsu, and Zhejiang port, aviation, and advanced-manufacturing nodes.',
      boundary: [
        { lat: 28.4, lon: 118.2 },
        { lat: 28.4, lon: 123.2 },
        { lat: 33.4, lon: 123.2 },
        { lat: 33.4, lon: 118.2 },
        { lat: 28.4, lon: 118.2 },
      ],
      nodes: [{
        id: 'china-node:yrd-port-shanghai',
        name: 'Shanghai',
        type: 'port',
        lat: 31.1918,
        lon: 121.6442,
        sourceOwner: 'IMF PortWatch',
        sourceSelector: { family: 'port', id: 'port1188' },
      }],
      availability: 'available',
      conditions: [{
        family: 'port',
        providerId: 'portwatch',
        availability: 'available',
        reason: null,
        sourceSignals: [{
          id: 'signal:portwatch:port1188:2026-07-25T11:00:00.000Z',
          family: 'port',
          selectorId: 'port1188',
          availability: 'available',
          publisher: { id: 'publisher:imf-portwatch', name: 'IMF PortWatch', type: 'official' },
          sourceUrl: 'https://portwatch.imf.org/',
          sourceScope: 'node',
          observationTime: '2026-07-25T11:00:00.000Z',
          observationTimePrecision: 'instant',
          releaseTime: null,
          releaseTimePrecision: 'unknown',
          retrievalTime: '2026-07-25T11:05:00.000Z',
          retrievalTimePrecision: 'instant',
          revision: null,
          transportFreshness: 'fresh',
          contentFreshness: 'current',
          summary: 'PortWatch activity observation available for Shanghai.',
          metrics: { tankerCalls30d: 14 },
        }],
        provenance: {
          contractVersion: provenanceContract.version,
          signalId: 'signal:corridor-condition:china-yangtze-river-delta:port:2026-07-25T11:00:00.000Z',
          familyId: 'composed_corridor_condition',
          claims: {
            publisher: {
              status: 'known',
              value: {
                id: 'publisher:worldmonitor-derived',
                name: 'WorldMonitor derived output',
                type: 'derived_output',
                registryReference: null,
              },
            },
            observation_time: {
              status: 'known',
              value: { role: 'observation', value: '2026-07-25T11:00:00.000Z', precision: 'instant' },
            },
            source_url: {
              status: 'not_applicable',
              reason: 'The corridor condition links source URLs through its input signals.',
            },
            original_reference: {
              status: 'not_applicable',
              reason: 'The corridor condition is composed from multiple source records.',
            },
            original_language: {
              status: 'not_applicable',
              reason: 'The deterministic composition has no original-language text.',
            },
            translation: {
              status: 'not_applicable',
              reason: 'The deterministic composition has no translated source text.',
            },
            effective_time: {
              status: 'known',
              value: { role: 'effective', value: '2026-07-25T11:00:00.000Z', precision: 'instant' },
            },
            publication_time: {
              status: 'not_applicable',
              reason: 'The computed condition is not a publisher release.',
            },
            retrieval_time: {
              status: 'known',
              value: { role: 'retrieval', value: '2026-07-25T11:05:00.000Z', precision: 'instant' },
            },
            revision: {
              status: 'known',
              value: {
                vintageId: 'china-yangtze-river-delta:port:2026-07-25T11:00:00.000Z',
                sequence: 1,
                state: 'original',
              },
            },
            supersession: {
              status: 'known',
              value: { state: 'current' },
            },
            extraction_confidence: {
              status: 'not_applicable',
              reason: 'Each input signal owns its extraction confidence.',
            },
            classification_confidence: {
              status: 'known',
              value: { score: 1, method: 'exact-reviewed-selector/v1' },
            },
            corroboration: {
              status: 'known',
              value: {
                state: 'single_source',
                sourceSignalIds: ['signal:portwatch:port1188:2026-07-25T11:00:00.000Z'],
              },
            },
            transport_freshness: {
              status: 'known',
              value: {
                state: 'fresh',
                assessedAt: '2026-07-25T12:00:00.000Z',
                lastSuccessAt: '2026-07-25T11:05:00.000Z',
              },
            },
            content_freshness: {
              status: 'known',
              value: {
                state: 'current',
                assessedAt: '2026-07-25T12:00:00.000Z',
                contentAsOf: '2026-07-25T11:00:00.000Z',
              },
            },
            derivation: {
              status: 'known',
              value: {
                methodId: 'worldmonitor:china-corridor-condition',
                methodVersion: '1',
                computedAt: '2026-07-25T12:00:00.000Z',
                inputSignalIds: ['signal:portwatch:port1188:2026-07-25T11:00:00.000Z'],
              },
            },
          },
        },
      }],
    }],
  };
  const unavailableFamilies = [
    'aviation',
    'hazard',
    'power_energy',
    'strategic_industry',
    'trade',
  ];
  payload.corridors[0].availability = 'partial';
  payload.corridors[0].conditions.push(...unavailableFamilies.map((family) => ({
    family,
    providerId: `provider:${family}`,
    availability: 'unavailable',
    reason: 'No reviewed source observation is available in this example.',
    sourceSignals: [],
    provenance: null,
  })));

  const corridorExamples = [
    {
      id: 'china-yangtze-river-delta',
      name: 'Yangtze River Delta',
      description: 'Reviewed coastal logistics corridor joining Shanghai, Jiangsu, and Zhejiang gateways.',
      boundary: [
        { lat: 28.4, lon: 118.2 },
        { lat: 28.4, lon: 123.2 },
        { lat: 33.4, lon: 123.2 },
        { lat: 33.4, lon: 118.2 },
        { lat: 28.4, lon: 118.2 },
      ],
      node: {
        id: 'china-node:yrd-port-shanghai',
        name: 'Shanghai',
        lat: 31.1918,
        lon: 121.6442,
        selectorId: 'port1188',
      },
    },
    {
      id: 'china-greater-bay-area',
      name: 'Greater Bay Area',
      description: 'Reviewed Pearl River Delta corridor connecting Guangdong, Hong Kong, and Macao-facing port, airport, and industrial gateways.',
      boundary: [
        { lat: 20.5, lon: 111.5 },
        { lat: 20.5, lon: 115.8 },
        { lat: 24.8, lon: 115.8 },
        { lat: 24.8, lon: 111.5 },
        { lat: 20.5, lon: 111.5 },
      ],
      node: {
        id: 'china-node:gba-port-shekou',
        name: 'Shekou Shenzhen',
        lat: 22.47,
        lon: 113.9,
        selectorId: 'port1189',
      },
    },
    {
      id: 'china-bohai-rim',
      name: 'Bohai Rim',
      description: 'Reviewed northern maritime-industrial corridor spanning Beijing-Tianjin, Hebei, Shandong, Liaoning, and their major gateways.',
      boundary: [
        { lat: 35.5, lon: 116 },
        { lat: 35.5, lon: 123.5 },
        { lat: 42.2, lon: 123.5 },
        { lat: 42.2, lon: 116 },
        { lat: 35.5, lon: 116 },
      ],
      node: {
        id: 'china-node:bohai-port-qingdao',
        name: 'Qingdao',
        lat: 36.07,
        lon: 120.32,
        selectorId: 'port1069',
      },
    },
    {
      id: 'china-western-land-sea-corridor',
      name: 'Western Land-Sea Corridor',
      description: 'Reviewed western corridor linking inland manufacturing hubs, Xinjiang land crossings, and Guangxi gateways to regional and maritime routes.',
      boundary: [
        { lat: 20.4, lon: 106.2 },
        { lat: 20.4, lon: 110.4 },
        { lat: 32.5, lon: 110.4 },
        { lat: 47, lon: 91 },
        { lat: 47, lon: 78.5 },
        { lat: 41, lon: 78.5 },
        { lat: 27, lon: 99.7 },
        { lat: 22, lon: 105.8 },
        { lat: 20.4, lon: 106.2 },
      ],
      node: {
        id: 'china-node:western-port-qinzhou',
        name: 'Qinzhou',
        lat: 21.6788,
        lon: 108.6383,
        selectorId: 'port1071',
      },
    },
  ];
  payload.corridors = corridorExamples.map((definition) => {
    const corridor = structuredClone(payload.corridors[0]);
    corridor.id = definition.id;
    corridor.name = definition.name;
    corridor.description = definition.description;
    corridor.boundary = definition.boundary;
    corridor.nodes = [{
      id: definition.node.id,
      name: definition.node.name,
      type: 'port',
      lat: definition.node.lat,
      lon: definition.node.lon,
      sourceOwner: 'IMF PortWatch',
      sourceSelector: { family: 'port', id: definition.node.selectorId },
    }];
    const port = corridor.conditions[0];
    const signal = port.sourceSignals[0];
    signal.id = `signal:portwatch:${definition.node.selectorId}:2026-07-25T11:00:00.000Z`;
    signal.selectorId = definition.node.selectorId;
    signal.summary = `PortWatch activity observation available for ${definition.node.name}.`;
    port.provenance.signalId =
      `signal:corridor-condition:${definition.id}:port:2026-07-25T11:00:00.000Z`;
    port.provenance.claims.revision.value.vintageId =
      `${definition.id}:port:2026-07-25T11:00:00.000Z`;
    port.provenance.claims.corroboration.value.sourceSignalIds = [signal.id];
    port.provenance.claims.derivation.value.inputSignalIds = [signal.id];
    return corridor;
  });
  return {
    payloadJson: JSON.stringify(payload),
    generatedAt: payload.generatedAt,
    upstreamUnavailable: false,
  };
}

function injectObject(spec, envelopeName, prefix) {
  Object.assign(spec.components.schemas, schemas(prefix));
  const payloadJson = spec.components.schemas[envelopeName].properties.payloadJson;
  spec.components.schemas[envelopeName].properties.payloadJson = {
    ...payloadJson,
    contentMediaType: 'application/json',
    contentSchema: ref(schemaNames(prefix).response),
  };
  const upstreamUnavailable =
    spec.components.schemas[envelopeName].properties.upstreamUnavailable;
  upstreamUnavailable.description = UPSTREAM_DESCRIPTION;
  const exampleHolder = spec.paths[RPC_PATH].get.responses['200'].content['application/json'];
  exampleHolder.example = responseExample();
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
  lines.splice(schemasIndex + 1, 0, ...renderedSchemas);

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
    `                        $ref: "#/components/schemas/${schemaNames(prefix).response}"`,
  );

  const updatedEnvelopeIndex = lines.findIndex((line) =>
    indentOf(line) === 8 && line.trim() === `${envelopeName}:`);
  const updatedEnvelopeEnd = blockEnd(lines, updatedEnvelopeIndex, 8);
  const upstreamIndex = lines.findIndex((line, index) =>
    index > updatedEnvelopeIndex
    && index < updatedEnvelopeEnd
    && indentOf(line) === 16
    && line.trim() === 'upstreamUnavailable:');
  if (upstreamIndex === -1) throw new Error(`${envelopeName} is missing upstreamUnavailable`);
  let upstreamEnd = blockEnd(lines, upstreamIndex, 16);
  for (let index = upstreamIndex + 1; index < upstreamEnd;) {
    if (indentOf(lines[index]) === 20 && lines[index].trim().startsWith('description:')) {
      const end = blockEnd(lines, index, 20);
      lines.splice(index, end - index);
      upstreamEnd -= end - index;
      continue;
    }
    index++;
  }
  lines.splice(
    upstreamIndex + 1,
    0,
    `                    description: ${JSON.stringify(UPSTREAM_DESCRIPTION)}`,
  );

  const pathIndex = lines.indexOf(`    ${RPC_PATH}:`);
  if (pathIndex === -1) throw new Error(`OpenAPI YAML is missing ${RPC_PATH}`);
  const pathEnd = blockEnd(lines, pathIndex, 4);
  const mediaIndex = lines.findIndex((line, index) =>
    index > pathIndex
    && index < pathEnd
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
  console.error(`x ${changed} OpenAPI artifact(s) missing the China corridor JSON contract`);
  console.error('  Run: node scripts/openapi-inject-china-corridors.mjs');
  process.exit(1);
}

console.log(
  CHECK
    ? 'ok China corridor JSON contract is present in every OpenAPI artifact'
    : `openapi-inject-china-corridors: updated ${changed} artifact(s)`,
);
