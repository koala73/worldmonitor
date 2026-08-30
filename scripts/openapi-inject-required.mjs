#!/usr/bin/env node
/**
 * Inject required request contracts into generated OpenAPI specs.
 *
 * The sebuf OpenAPI generator currently preserves request-schema `required`
 * arrays, but many matching query parameter objects are still emitted as
 * `required: false`. It also cannot infer runtime-required fields that are
 * expressed with WorldMonitor's local `(sebuf.http.query).required` annotation
 * until the generated artifacts have been post-processed.
 *
 * This step is intentionally formatting-preserving for YAML artifacts and uses
 * the same JSON serialization contract as scripts/openapi-inject-security.mjs.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');
const bundlePath = resolve(apiDir, 'worldmonitor.openapi.yaml');
const protoWorldmonitorDir = resolve(root, 'proto/worldmonitor');
const CHECK = process.argv.includes('--check');
const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head']);

// Fields that are required in the public OpenAPI request contract but are not
// safe to express as buf.validate.required because runtime code has a
// documented conditional bypass. Keep this list tiny and explain each entry.
const OPENAPI_ONLY_REQUIRED_FIELDS = new Map([
  [
    'RegisterInterestRequest',
    [
      {
        jsonName: 'turnstileToken',
        protoName: 'turnstile_token',
        queryName: 'turnstile_token',
        reason: 'Desktop register-interest requests can bypass Turnstile with signed desktop auth.',
      },
    ],
  ],
]);

// Response fields that the scorecard handlers always materialize. The proto3
// generator cannot infer JSON requiredness from scalar defaults, so keep this
// explicit until sebuf can express response-shape invariants directly.
const OPENAPI_REQUIRED_SCHEMA_FIELDS = new Map([
  ['GetFiveFactorScorecardResponse', ['unavailable', 'unavailableReason']],
  ['GetBlocScorecardResponse', ['unavailable', 'unavailableReason']],
  ['ListFiveFactorScorecardsResponse', ['scorecards', 'unavailable', 'unavailableReason', 'methodologyVersion', 'computedAt']],
  ['FiveFactorCountryScorecard', ['countryCode', 'methodologyVersion', 'computedAt', 'pillars']],
  ['FiveFactorBlocScorecard', ['id', 'label', 'methodologyVersion', 'computedAt', 'members', 'includedMembers', 'excludedMembers', 'pillars']],
  ['FiveFactorPillar', ['pillar', 'hasScore', 'score', 'subScore', 'band', 'inputCoverage', 'aggregationMethod', 'inputs', 'insufficientReasons', 'includedMembers', 'excludedMembers', 'memberWeights']],
  ['ScorecardEvidence', ['inputId', 'available', 'value', 'hasValue', 'year', 'unit', 'source', 'sourceKey', 'unavailableReason', 'quality', 'observations', 'countryCode']],
  ['ScorecardObservation', ['name', 'value', 'year', 'unit', 'source', 'indicatorCode']],
  ['ExcludedBlocMember', ['countryCode', 'reason']],
  ['ScorecardMemberWeight', ['countryCode', 'populationMillions', 'hasPopulation']],
  ['FiveFactorCountryScorecardSummary', ['countryCode', 'pillars']],
  ['FiveFactorPillarSummary', ['pillar', 'hasScore', 'score', 'subScore', 'band', 'inputCoverage', 'insufficientReasons']],
]);

const SCORECARD_REASON_PATTERN = '^(?:source-unavailable|country-unavailable|invalid-value|stale|coverage-below-floor|required-group-missing|missing-population|redistribution-blocked)$';
const ISO2_PATTERN = '^[A-Z]{2}$';

function scorecardResponseOneOf(unavailableReasons) {
  return [
    {
      required: ['scorecard'],
      properties: { unavailable: { const: false }, unavailableReason: { const: '' } },
    },
    {
      not: { required: ['scorecard'] },
      properties: { unavailable: { const: true }, unavailableReason: { enum: unavailableReasons } },
    },
  ];
}

function injectScorecardJsonContracts(spec) {
  const schemas = spec.components?.schemas;
  if (!schemas?.GetBlocScorecardRequest) return false;
  let changed = false;
  const set = (target, key, value) => {
    if (!eq(target?.[key], value)) {
      target[key] = value;
      changed = true;
    }
  };

  const blocRequest = schemas.GetBlocScorecardRequest;
  set(blocRequest.properties, 'members', {
    type: 'array',
    items: { type: 'string', pattern: ISO2_PATTERN },
    minItems: 2,
    maxItems: 30,
    uniqueItems: true,
    description: 'Custom list of 2-30 unique uppercase ISO 3166-1 alpha-2 members. Provide either preset or members; do not provide both.',
  });
  set(blocRequest, 'oneOf', [
    { required: ['preset'], not: { required: ['members'] } },
    { required: ['members'], not: { required: ['preset'] } },
  ]);

  const repeatedStringContracts = [
    ['FiveFactorPillar', 'insufficientReasons', SCORECARD_REASON_PATTERN],
    ['FiveFactorPillar', 'includedMembers', ISO2_PATTERN],
    ['FiveFactorPillarSummary', 'insufficientReasons', SCORECARD_REASON_PATTERN],
    ['FiveFactorBlocScorecard', 'members', ISO2_PATTERN],
    ['FiveFactorBlocScorecard', 'includedMembers', ISO2_PATTERN],
  ];
  for (const [schemaName, field, pattern] of repeatedStringContracts) {
    if (schemas[schemaName]?.properties?.[field]) {
      set(schemas[schemaName].properties[field], 'items', { type: 'string', pattern });
    }
  }

  set(schemas.GetFiveFactorScorecardResponse, 'oneOf', scorecardResponseOneOf([
    'country-unavailable',
    'scorecard-snapshot-unavailable',
  ]));
  set(schemas.GetBlocScorecardResponse, 'oneOf', scorecardResponseOneOf([
    'bloc-members-unavailable',
    'scorecard-snapshot-unavailable',
  ]));
  set(schemas.ListFiveFactorScorecardsResponse, 'oneOf', [
    {
      properties: {
        unavailable: { const: false },
        unavailableReason: { const: '' },
        methodologyVersion: { const: '1.0.0' },
      },
    },
    {
      properties: {
        unavailable: { const: true },
        unavailableReason: { const: 'scorecard-snapshot-unavailable' },
        methodologyVersion: { const: '' },
        computedAt: { const: '' },
        scorecards: { maxItems: 0 },
      },
    },
  ]);

  const operation = spec.paths?.['/api/scorecard/v1/get-bloc-scorecard']?.get;
  const membersParam = operation?.parameters?.find((param) => param?.in === 'query' && param.name === 'members');
  if (membersParam) {
    set(membersParam, 'schema', {
      type: 'array',
      items: { type: 'string', pattern: ISO2_PATTERN },
      minItems: 2,
      maxItems: 30,
      uniqueItems: true,
    });
    set(operation, 'x-worldmonitor-selector-one-of', ['preset', 'members']);
  }
  return changed;
}

const sortRec = (x) =>
  Array.isArray(x)
    ? x.map(sortRec)
    : x && typeof x === 'object'
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sortRec(x[k])]))
      : x;

const goEscape = (s) => {
  let r = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    r += c === 0x3c || c === 0x3e || c === 0x26 || c === 0x2028 || c === 0x2029
      ? '\\u' + c.toString(16).padStart(4, '0')
      : ch;
  }
  return r;
};

const serialize = (obj) => goEscape(JSON.stringify(sortRec(obj)));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function listProtoFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const p = resolve(dir, entry.name);
    if (entry.isDirectory()) return listProtoFiles(p);
    return entry.isFile() && entry.name.endsWith('.proto') ? [p] : [];
  });
}

function findMatchingBrace(src, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced proto message block near offset ${openIndex}`);
}

function toJsonName(protoName) {
  return protoName.replace(/_([a-z0-9])/g, (_m, ch) => ch.toUpperCase());
}

function toSnakeName(jsonName) {
  return jsonName.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}

function readProtoRequiredFields() {
  const messages = new Map();
  const requiredMessageOrigins = new Map();
  for (const file of listProtoFiles(protoWorldmonitorDir)) {
    const src = readFileSync(file, 'utf8');
    const messageRe = /\bmessage\s+(\w+)\s*\{/g;
    let msgMatch;
    while ((msgMatch = messageRe.exec(src))) {
      const messageName = msgMatch[1];
      const open = src.indexOf('{', msgMatch.index);
      const close = findMatchingBrace(src, open);
      const body = src.slice(open + 1, close);
      const fieldRe = /(?:^|\n)\s*(?:optional\s+)?(?:repeated\s+)?(?:map\s*<[^>]+>|[\w.]+)\s+(\w+)\s*=\s*\d+\s*(\[[\s\S]*?\])?\s*;/g;
      let fieldMatch;
      while ((fieldMatch = fieldRe.exec(body))) {
        const protoName = fieldMatch[1];
        const options = fieldMatch[2] ?? '';
        const queryBlock = options.match(/\(sebuf\.http\.query\)\s*=\s*\{([\s\S]*?)\}/);
        const requiredByValidate = /\(buf\.validate\.field\)\.required\s*=\s*true/.test(options);
        const requiredByQuery = queryBlock ? /\brequired\s*:\s*true\b/.test(queryBlock[1]) : false;
        if (!requiredByValidate && !requiredByQuery) continue;

        const jsonName = toJsonName(protoName);
        const queryName = queryBlock?.[1].match(/\bname\s*:\s*"([^"]+)"/)?.[1] ?? protoName;
        const existingOrigin = requiredMessageOrigins.get(messageName);
        if (existingOrigin && existingOrigin !== file) {
          throw new Error(`required-field message name collision for ${messageName}: ${existingOrigin} and ${file}`);
        }
        requiredMessageOrigins.set(messageName, file);

        const existing = messages.get(messageName) ?? new Map();
        existing.set(jsonName, { jsonName, protoName, queryName });
        messages.set(messageName, existing);
      }
      messageRe.lastIndex = close + 1;
    }
  }
  for (const [messageName, fields] of OPENAPI_ONLY_REQUIRED_FIELDS) {
    const existing = messages.get(messageName) ?? new Map();
    for (const field of fields) existing.set(field.jsonName, field);
    messages.set(messageName, existing);
  }

  return messages;
}

const PROTO_REQUIRED_FIELDS = readProtoRequiredFields();

function requiredFieldsForSchema(schemaName, schema) {
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const protoFields = PROTO_REQUIRED_FIELDS.get(schemaName);
  if (protoFields && schema?.properties && typeof schema.properties === 'object') {
    for (const field of protoFields.values()) {
      if (Object.prototype.hasOwnProperty.call(schema.properties, field.jsonName)) {
        required.add(field.jsonName);
      }
    }
  }
  for (const field of OPENAPI_REQUIRED_SCHEMA_FIELDS.get(schemaName) ?? []) {
    if (Object.prototype.hasOwnProperty.call(schema?.properties ?? {}, field)) required.add(field);
  }
  return required;
}

function orderedRequired(schema, requiredSet) {
  const existing = Array.isArray(schema?.required) ? schema.required.filter((field) => requiredSet.has(field)) : [];
  const ordered = [...existing];
  const props = schema?.properties && typeof schema.properties === 'object' ? Object.keys(schema.properties) : [];
  for (const key of props) {
    if (requiredSet.has(key) && !ordered.includes(key)) ordered.push(key);
  }
  for (const key of requiredSet) {
    if (!ordered.includes(key)) ordered.push(key);
  }
  return ordered;
}

function queryNamesForRequiredFields(schemaName, schema) {
  const required = requiredFieldsForSchema(schemaName, schema);
  const names = new Set();
  const protoFields = PROTO_REQUIRED_FIELDS.get(schemaName);
  for (const jsonName of required) {
    names.add(jsonName);
    names.add(toSnakeName(jsonName));
    const protoField = protoFields?.get(jsonName);
    if (protoField?.queryName) names.add(protoField.queryName);
    if (protoField?.protoName) names.add(protoField.protoName);
  }
  return names;
}

function injectJson(spec) {
  let changed = injectScorecardJsonContracts(spec);
  const schemas = spec.components?.schemas ?? {};

  for (const [schemaName, schema] of Object.entries(schemas)) {
    if ((!schemaName.endsWith('Request') && !OPENAPI_REQUIRED_SCHEMA_FIELDS.has(schemaName)) || !schema || typeof schema !== 'object') continue;
    const required = requiredFieldsForSchema(schemaName, schema);
    if (required.size === 0) continue;
    const next = orderedRequired(schema, required);
    if (!eq(schema.required, next)) {
      schema.required = next;
      changed = true;
    }
  }

  for (const ops of Object.values(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(ops ?? {})) {
      if (!HTTP_METHODS.has(method) || !op || typeof op !== 'object') continue;
      const schemaName = `${op.operationId ?? ''}Request`;
      const schema = schemas[schemaName];
      if (!schema || typeof schema !== 'object') continue;
      const requiredQueryNames = queryNamesForRequiredFields(schemaName, schema);
      if (requiredQueryNames.size === 0) continue;
      for (const param of op.parameters ?? []) {
        if (param?.in !== 'query') continue;
        if (requiredQueryNames.has(param.name) && param.required !== true) {
          param.required = true;
          changed = true;
        }
      }
    }
  }

  return changed;
}

function leadingSpaces(line) {
  return line.match(/^ */)[0].length;
}

function setYamlOperationParamRequired(lines, operationId, paramName) {
  const operationIndex = lines.findIndex((line) => line.trim() === `operationId: ${operationId}`);
  if (operationIndex === -1) return false;

  let operationEnd = operationIndex + 1;
  while (operationEnd < lines.length) {
    const line = lines[operationEnd];
    if (line.trim() && leadingSpaces(line) <= 8) break;
    operationEnd++;
  }

  let changed = false;
  for (let i = operationIndex + 1; i < operationEnd; i++) {
    if (lines[i] !== `                - name: ${paramName}`) continue;
    let paramEnd = i + 1;
    while (paramEnd < operationEnd) {
      const line = lines[paramEnd];
      if (line.startsWith('                - name: ')) break;
      if (line.trim() && leadingSpaces(line) <= 12) break;
      paramEnd++;
    }
    const isQuery = lines.slice(i, paramEnd).some((line) => line.trim() === 'in: query');
    if (!isQuery) continue;
    const requiredIndex = lines.slice(i, paramEnd).findIndex((line) => line.trim().startsWith('required:'));
    if (requiredIndex === -1) {
      const inIndex = lines.slice(i, paramEnd).findIndex((line) => line.trim() === 'in: query');
      const insertAt = i + inIndex + 1;
      lines.splice(insertAt, 0, '                  required: true');
      changed = true;
      operationEnd++;
      i++;
      continue;
    }
    const absoluteRequiredIndex = i + requiredIndex;
    if (lines[absoluteRequiredIndex] !== '                  required: true') {
      lines[absoluteRequiredIndex] = '                  required: true';
      changed = true;
    }
  }
  return changed;
}

function schemaHeaderMatches(line, schemaName) {
  if (!line.startsWith('        ') || line.startsWith('            ')) return false;
  const key = line.trim().slice(0, -1);
  return key === schemaName || key.endsWith(`_${schemaName}`);
}

function setYamlSchemaRequired(lines, schemaName, required) {
  if (required.length === 0) return false;
  let changed = false;
  for (let schemaIndex = 0; schemaIndex < lines.length; schemaIndex++) {
    if (!schemaHeaderMatches(lines[schemaIndex], schemaName)) continue;
    let schemaEnd = schemaIndex + 1;
    while (schemaEnd < lines.length) {
      const line = lines[schemaEnd];
      if (line.trim() && leadingSpaces(line) <= 8) break;
      schemaEnd++;
    }

    const expected = ['            required:', ...required.map((field) => `                - ${field}`)];
    let requiredIndex = -1;
    for (let i = schemaIndex + 1; i < schemaEnd; i++) {
      if (lines[i] === '            required:') {
        requiredIndex = i;
        break;
      }
    }

    if (requiredIndex !== -1) {
      let requiredEnd = requiredIndex + 1;
      while (requiredEnd < schemaEnd && lines[requiredEnd].startsWith('                - ')) requiredEnd++;
      const current = lines.slice(requiredIndex, requiredEnd);
      if (!eq(current, expected)) {
        lines.splice(requiredIndex, requiredEnd - requiredIndex, ...expected);
        changed = true;
      }
      continue;
    }

    let insertAt = -1;
    const relative = lines.slice(schemaIndex, schemaEnd);
    const propertiesIndex = relative.indexOf('            properties:');
    if (propertiesIndex !== -1) {
      insertAt = schemaIndex + propertiesIndex + 1;
      while (insertAt < schemaEnd) {
        const line = lines[insertAt];
        if (line.trim() && leadingSpaces(line) <= 12) break;
        insertAt++;
      }
    } else {
      const typeIndex = relative.indexOf('            type: object');
      insertAt = typeIndex === -1 ? schemaEnd : schemaIndex + typeIndex + 1;
    }
    lines.splice(insertAt, 0, ...expected);
    changed = true;
    schemaIndex = insertAt + expected.length - 1;
  }
  return changed;
}

function requiredYamlContractsForSpec(spec) {
  const params = [];
  const schemas = new Map();
  for (const [schemaName, schema] of Object.entries(spec.components?.schemas ?? {})) {
    if (!Array.isArray(schema.required) || schema.required.length === 0) continue;
    schemas.set(schemaName, schema.required);
  }
  for (const ops of Object.values(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(ops ?? {})) {
      if (!HTTP_METHODS.has(method) || !op || typeof op !== 'object') continue;
      for (const param of op.parameters ?? []) {
        if (param?.in === 'query' && param.required === true) {
          params.push({ operationId: op.operationId, paramName: param.name });
        }
      }
    }
  }
  return { params, schemas };
}

function replaceYamlSchemaProperty(lines, schemaName, fieldName, render) {
  let changed = false;
  for (const block of [...yamlSchemaBlocks(lines, schemaName)].reverse()) {
    const schemaIndent = leadingSpaces(lines[block.start]);
    const propertyIndent = schemaIndent + 8;
    let fieldIndex = -1;
    for (let i = block.start + 1; i < block.end; i++) {
      if (leadingSpaces(lines[i]) === propertyIndent && lines[i].trim() === `${fieldName}:`) {
        fieldIndex = i;
        break;
      }
    }
    if (fieldIndex === -1) continue;

    let fieldEnd = fieldIndex + 1;
    while (fieldEnd < block.end) {
      const line = lines[fieldEnd];
      if (line.trim() && leadingSpaces(line) <= propertyIndent) break;
      fieldEnd++;
    }
    const expected = render(' '.repeat(propertyIndent));
    if (!eq(lines.slice(fieldIndex, fieldEnd), expected)) {
      lines.splice(fieldIndex, fieldEnd - fieldIndex, ...expected);
      changed = true;
    }
  }
  return changed;
}

function setYamlSchemaChild(lines, schemaName, childName, render) {
  let changed = false;
  for (const block of [...yamlSchemaBlocks(lines, schemaName)].reverse()) {
    const schemaIndent = leadingSpaces(lines[block.start]);
    const childIndent = schemaIndent + 4;
    let childIndex = -1;
    for (let i = block.start + 1; i < block.end; i++) {
      if (leadingSpaces(lines[i]) === childIndent && lines[i].trim() === `${childName}:`) {
        childIndex = i;
        break;
      }
    }

    let childEnd = childIndex + 1;
    if (childIndex !== -1) {
      while (childEnd < block.end) {
        const line = lines[childEnd];
        if (line.trim() && leadingSpaces(line) <= childIndent) break;
        childEnd++;
      }
    }
    const expected = render(' '.repeat(childIndent));
    if (childIndex !== -1) {
      if (!eq(lines.slice(childIndex, childEnd), expected)) {
        lines.splice(childIndex, childEnd - childIndex, ...expected);
        changed = true;
      }
      continue;
    }

    let insertAt = block.end;
    for (let i = block.start + 1; i < block.end; i++) {
      if (leadingSpaces(lines[i]) === childIndent && lines[i].trim() === 'required:') {
        insertAt = i;
        break;
      }
    }
    lines.splice(insertAt, 0, ...expected);
    changed = true;
  }
  return changed;
}

function setYamlScorecardMembersParameter(lines) {
  let changed = false;
  for (const block of [...yamlOperationBlocks(lines, 'GetBlocScorecard')].reverse()) {
    for (let i = block.start + 1; i < block.end; i++) {
      if (lines[i].trim() !== '- name: members') continue;
      const indent = leadingSpaces(lines[i]);
      let end = i + 1;
      while (end < block.end) {
        const line = lines[end];
        if (line.trim() && leadingSpaces(line) <= indent) break;
        end++;
      }
      const pad = ' '.repeat(indent);
      const expected = [
        `${pad}- name: members`,
        `${pad}  in: query`,
        `${pad}  description: Custom list of 2-30 unique uppercase ISO 3166-1 alpha-2 members. Provide either preset or members; do not provide both.`,
        `${pad}  required: false`,
        `${pad}  style: form`,
        `${pad}  explode: true`,
        `${pad}  schema:`,
        `${pad}    type: array`,
        `${pad}    items:`,
        `${pad}        type: string`,
        `${pad}        pattern: ^[A-Z]{2}$`,
        `${pad}    minItems: 2`,
        `${pad}    maxItems: 30`,
        `${pad}    uniqueItems: true`,
      ];
      if (!eq(lines.slice(i, end), expected)) {
        lines.splice(i, end - i, ...expected);
        changed = true;
      }
      break;
    }
  }
  return changed;
}

function setYamlScorecardSelectorExtension(lines) {
  let changed = false;
  for (const block of [...yamlOperationBlocks(lines, 'GetBlocScorecard')].reverse()) {
    const operationIndent = leadingSpaces(lines[block.start]);
    let extensionIndex = -1;
    for (let i = block.start + 1; i < block.end; i++) {
      if (leadingSpaces(lines[i]) === operationIndent && lines[i].trim() === 'x-worldmonitor-selector-one-of:') {
        extensionIndex = i;
        break;
      }
    }
    const pad = ' '.repeat(operationIndent);
    const expected = [
      `${pad}x-worldmonitor-selector-one-of:`,
      `${pad}    - preset`,
      `${pad}    - members`,
    ];
    let responsesIndex = -1;
    for (let i = block.start + 1; i < block.end; i++) {
      if (leadingSpaces(lines[i]) === operationIndent && lines[i].trim() === 'responses:') {
        responsesIndex = i;
        break;
      }
    }
    if (responsesIndex === -1) continue;
    if (extensionIndex === responsesIndex - expected.length
        && eq(lines.slice(extensionIndex, responsesIndex), expected)) continue;

    if (extensionIndex !== -1) {
      const removable = lines.slice(extensionIndex, extensionIndex + expected.length);
      if (!eq(removable, expected)) {
        throw new Error('unexpected GetBlocScorecard selector extension shape');
      }
      lines.splice(extensionIndex, expected.length);
      if (extensionIndex < responsesIndex) responsesIndex -= expected.length;
    }
    lines.splice(responsesIndex, 0, ...expected);
    changed = true;
  }
  return changed;
}

function injectYamlScorecardContracts(lines) {
  if (yamlSchemaBlocks(lines, 'GetBlocScorecardRequest').length === 0) return false;
  let changed = false;
  const arrayProperty = (fieldName, pattern, extra = []) => (pad) => [
    `${pad}${fieldName}:`,
    `${pad}    type: array`,
    `${pad}    items:`,
    `${pad}        type: string`,
    `${pad}        pattern: ${pattern}`,
    ...extra.map((line) => `${pad}    ${line}`),
  ];
  const responseOneOf = (reasons) => (pad) => [
    `${pad}oneOf:`,
    `${pad}    - required:`,
    `${pad}        - scorecard`,
    `${pad}      properties:`,
    `${pad}        unavailable:`,
    `${pad}            const: false`,
    `${pad}        unavailableReason:`,
    `${pad}            const: ''`,
    `${pad}    - not:`,
    `${pad}        required:`,
    `${pad}            - scorecard`,
    `${pad}      properties:`,
    `${pad}        unavailable:`,
    `${pad}            const: true`,
    `${pad}        unavailableReason:`,
    `${pad}            enum:`,
    ...reasons.map((reason) => `${pad}                - ${reason}`),
  ];

  if (replaceYamlSchemaProperty(lines, 'GetBlocScorecardRequest', 'members', arrayProperty('members', ISO2_PATTERN, [
    'minItems: 2',
    'maxItems: 30',
    'uniqueItems: true',
    'description: Custom list of 2-30 unique uppercase ISO 3166-1 alpha-2 members. Provide either preset or members; do not provide both.',
  ]))) changed = true;
  if (setYamlSchemaChild(lines, 'GetBlocScorecardRequest', 'oneOf', (pad) => [
    `${pad}oneOf:`,
    `${pad}    - required:`,
    `${pad}        - preset`,
    `${pad}      not:`,
    `${pad}        required:`,
    `${pad}            - members`,
    `${pad}    - required:`,
    `${pad}        - members`,
    `${pad}      not:`,
    `${pad}        required:`,
    `${pad}            - preset`,
  ])) changed = true;

  for (const [schemaName, fieldName, pattern] of [
    ['FiveFactorPillar', 'insufficientReasons', SCORECARD_REASON_PATTERN],
    ['FiveFactorPillar', 'includedMembers', ISO2_PATTERN],
    ['FiveFactorPillarSummary', 'insufficientReasons', SCORECARD_REASON_PATTERN],
    ['FiveFactorBlocScorecard', 'members', ISO2_PATTERN],
    ['FiveFactorBlocScorecard', 'includedMembers', ISO2_PATTERN],
  ]) {
    if (replaceYamlSchemaProperty(lines, schemaName, fieldName, arrayProperty(fieldName, pattern))) changed = true;
  }

  if (setYamlSchemaChild(lines, 'GetFiveFactorScorecardResponse', 'oneOf', responseOneOf([
    'country-unavailable',
    'scorecard-snapshot-unavailable',
  ]))) changed = true;
  if (setYamlSchemaChild(lines, 'GetBlocScorecardResponse', 'oneOf', responseOneOf([
    'bloc-members-unavailable',
    'scorecard-snapshot-unavailable',
  ]))) changed = true;
  if (setYamlSchemaChild(lines, 'ListFiveFactorScorecardsResponse', 'oneOf', (pad) => [
    `${pad}oneOf:`,
    `${pad}    - properties:`,
    `${pad}        unavailable:`,
    `${pad}            const: false`,
    `${pad}        unavailableReason:`,
    `${pad}            const: ''`,
    `${pad}        methodologyVersion:`,
    `${pad}            const: 1.0.0`,
    `${pad}    - properties:`,
    `${pad}        unavailable:`,
    `${pad}            const: true`,
    `${pad}        unavailableReason:`,
    `${pad}            const: scorecard-snapshot-unavailable`,
    `${pad}        methodologyVersion:`,
    `${pad}            const: ''`,
    `${pad}        computedAt:`,
    `${pad}            const: ''`,
    `${pad}        scorecards:`,
    `${pad}            maxItems: 0`,
  ])) changed = true;
  if (setYamlScorecardMembersParameter(lines)) changed = true;
  if (setYamlScorecardSelectorExtension(lines)) changed = true;
  return changed;
}

function injectYaml(text, contracts) {
  const lines = text.split('\n');
  let changed = injectYamlScorecardContracts(lines);
  for (const { operationId, paramName } of contracts.params) {
    if (operationId && setYamlOperationParamRequired(lines, operationId, paramName)) changed = true;
  }
  for (const [schemaName, required] of contracts.schemas) {
    if (setYamlSchemaRequired(lines, schemaName, required)) changed = true;
  }
  return { text: lines.join('\n'), changed };
}

function yamlOperationBlocks(lines, operationId) {
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== `operationId: ${operationId}`) continue;
    let end = i + 1;
    while (end < lines.length && !lines[end].trim().startsWith('operationId: ')) end++;
    blocks.push({ start: i, end });
  }
  return blocks;
}

function yamlParamRequiredInBlock(lines, block, paramName) {
  for (let i = block.start + 1; i < block.end; i++) {
    if (lines[i].trim() !== `- name: ${paramName}`) continue;
    let paramEnd = i + 1;
    while (paramEnd < block.end) {
      const trimmed = lines[paramEnd].trim();
      if (trimmed.startsWith('- name: ') || trimmed === 'responses:') break;
      paramEnd++;
    }
    const paramLines = lines.slice(i, paramEnd).map((line) => line.trim());
    if (paramLines.includes('in: query')) return paramLines.includes('required: true');
  }
  return null;
}

function yamlSchemaBlocks(lines, schemaName) {
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.endsWith(':')) continue;
    const key = trimmed.slice(0, -1);
    if (key !== schemaName && !key.endsWith(`_${schemaName}`)) continue;
    const indent = leadingSpaces(lines[i]);
    let end = i + 1;
    while (end < lines.length) {
      const line = lines[end];
      if (line.trim() && leadingSpaces(line) <= indent) break;
      end++;
    }
    blocks.push({ name: key, start: i, end });
  }
  return blocks;
}

function yamlRequiredFields(lines, block) {
  for (let i = block.start + 1; i < block.end; i++) {
    if (lines[i].trim() !== 'required:') continue;
    const fields = [];
    for (let j = i + 1; j < block.end; j++) {
      const trimmed = lines[j].trim();
      if (trimmed.startsWith('- ')) fields.push(trimmed.slice(2));
      else if (trimmed) break;
    }
    return fields;
  }
  return [];
}

function yamlContractFailures(text, contracts, label) {
  const failures = [];
  const lines = text.split('\n');

  const seenParams = new Set();
  for (const { operationId, paramName } of contracts.params) {
    if (!operationId) continue;
    const key = `${operationId}:${paramName}`;
    if (seenParams.has(key)) continue;
    seenParams.add(key);

    const blocks = yamlOperationBlocks(lines, operationId);
    if (blocks.length === 0) {
      failures.push(`${label}: missing operationId ${operationId}`);
      continue;
    }
    for (const block of blocks) {
      const required = yamlParamRequiredInBlock(lines, block, paramName);
      if (required === null) failures.push(`${label}: ${operationId} missing query parameter ${paramName}`);
      else if (!required) failures.push(`${label}: ${operationId}.${paramName} required is not true`);
    }
  }

  for (const [schemaName, required] of contracts.schemas) {
    const matches = yamlSchemaBlocks(lines, schemaName);
    if (matches.length === 0) {
      failures.push(`${label}: missing schema ${schemaName}`);
      continue;
    }
    if (matches.length > 1) {
      failures.push(`${label}: ambiguous schema ${schemaName}: ${matches.map((match) => match.name).join(', ')}`);
      continue;
    }
    const fields = yamlRequiredFields(lines, matches[0]);
    for (const field of required) {
      if (!fields.includes(field)) failures.push(`${label}: ${matches[0].name}.required missing ${field}`);
    }
  }

  return failures;
}

function failYamlContracts(failures) {
  if (failures.length === 0) return;
  throw new Error(`OpenAPI YAML requiredness injection failed:\n${failures.join('\n')}`);
}

const specFiles = readdirSync(apiDir).filter((f) => /Service\.openapi\.json$/.test(f)).sort();
let wouldChange = 0;
const touched = [];
const contractFailures = [];
const bundleContracts = { params: [], schemas: new Map() };

for (const file of specFiles) {
  const jsonPath = resolve(apiDir, file);
  const spec = JSON.parse(readFileSync(jsonPath, 'utf8'));
  if (injectJson(spec)) {
    wouldChange++;
    touched.push(file);
    if (!CHECK) writeFileSync(jsonPath, serialize(spec));
  }

  const contracts = requiredYamlContractsForSpec(spec);
  bundleContracts.params.push(...contracts.params);
  for (const [schemaName, required] of contracts.schemas) {
    bundleContracts.schemas.set(schemaName, required);
  }

  const yamlPath = jsonPath.replace(/\.json$/, '.yaml');
  try {
    const yamlRaw = readFileSync(yamlPath, 'utf8');
    const { text, changed } = injectYaml(yamlRaw, contracts);
    if (changed) {
      wouldChange++;
      touched.push(file.replace(/\.json$/, '.yaml'));
      if (!CHECK) writeFileSync(yamlPath, text);
    }
    const failures = yamlContractFailures(text, contracts, file.replace(/\.json$/, '.yaml'));
    contractFailures.push(...failures);
    if (!CHECK) failYamlContracts(failures);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

try {
  const bundleRaw = readFileSync(bundlePath, 'utf8');
  const { text, changed } = injectYaml(bundleRaw, bundleContracts);
  if (changed) {
    wouldChange++;
    touched.push('worldmonitor.openapi.yaml');
    if (!CHECK) writeFileSync(bundlePath, text);
  }
  const failures = yamlContractFailures(text, bundleContracts, 'worldmonitor.openapi.yaml');
  contractFailures.push(...failures);
  if (!CHECK) failYamlContracts(failures);
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

if (CHECK) {
  if (wouldChange > 0 || contractFailures.length > 0) {
    console.error(`x ${wouldChange} OpenAPI artifact(s) missing requiredness contract: ${touched.join(', ')}`);
    for (const failure of contractFailures) console.error(`  ${failure}`);
    console.error('  Run: npm run gen:openapi:required');
    process.exit(1);
  }
  console.log(`ok all ${specFiles.length} specs + bundle carry requiredness contract`);
} else {
  console.log(`openapi-inject-required: updated ${wouldChange} artifact(s) - ${specFiles.length} specs scanned`);
}
