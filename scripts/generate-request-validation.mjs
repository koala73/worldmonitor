#!/usr/bin/env node

/**
 * Generate the runtime request-validation registry consumed by sebuf routes.
 *
 * The sebuf TypeScript server generator exposes a validateRequest callback but
 * does not emit validators for buf.validate annotations. This script parses
 * the proto source with protobufjs, associates every generated callback name
 * with its request type, and writes the compact metadata used by the edge and
 * Vite runtimes. It deliberately fails on unknown validation rules, missing
 * generated methods, and callback-name collisions so validation cannot become
 * silently permissive as the API evolves.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, '..');
const PROTO_ROOT = join(ROOT, 'proto', 'worldmonitor');
const GENERATED_SERVER_ROOT = join(ROOT, 'src', 'generated', 'server');
const OUTPUT = join(GENERATED_SERVER_ROOT, 'request_validation.ts');
const CHECK_ONLY = process.argv.includes('--check');
const RULE_PREFIX = '(buf.validate.field).';

const SUPPORTED_RULES = new Set([
  'required',
  'ignore',
  'string.len',
  'string.min_len',
  'string.max_len',
  'string.max_bytes',
  'string.const',
  'string.pattern',
  'int32.const',
  'int32.gte',
  'int32.lte',
  'int64.gte',
  'int64.lte',
  'double.gte',
  'double.lte',
  'enum.defined_only',
  'enum.not_in',
  'repeated.min_items',
  'repeated.max_items',
  'repeated.items.string.min_len',
  'repeated.items.string.max_bytes',
  'repeated.items.string.pattern',
]);
// This response-only rule is safe for the repository-wide proto audit but has
// no request-side runtime implementation. Reject it if a future request makes
// it reachable instead of silently dropping the constraint.
const RESPONSE_ONLY_RULES = new Set(['int32.const']);

function walkProtoFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? walkProtoFiles(path) : [path];
    })
    .filter((path) => path.endsWith('.proto'))
    .sort();
}

function walkReflectionObjects(object, visit) {
  for (const child of Object.values(object.nested ?? {})) {
    visit(child);
    walkReflectionObjects(child, visit);
  }
}

function normalizedTypeName(type) {
  return type.fullName.replace(/^\./, '');
}

function validationOptions(field) {
  return Object.fromEntries(
    Object.entries(field.options ?? {})
      .filter(([key]) => key.startsWith(RULE_PREFIX))
      .map(([key, value]) => [key.slice(RULE_PREFIX.length), value]),
  );
}

function assertSupportedRules(root) {
  let ruleCount = 0;
  walkReflectionObjects(root, (object) => {
    if (!(object instanceof protobuf.Type)) return;
    for (const field of object.fieldsArray) {
      for (const rule of Object.keys(validationOptions(field))) {
        ruleCount += 1;
        if (!SUPPORTED_RULES.has(rule)) {
          throw new Error(
            `Unsupported buf.validate rule ${rule} on ${object.fullName}.${field.name}; `
            + 'extend the runtime validator before regenerating.',
          );
        }
      }
    }
  });
  return ruleCount;
}

function collectServices(root) {
  const services = [];
  walkReflectionObjects(root, (object) => {
    if (object instanceof protobuf.Service) services.push(object);
  });
  return services.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

function typeReachesValidationRules(type, ancestors = new Set()) {
  if (ancestors.has(type)) return false;
  const nextAncestors = new Set(ancestors).add(type);
  return type.fieldsArray.some((field) => (
    Object.keys(validationOptions(field)).length > 0
    || (field.resolvedType instanceof protobuf.Type
      && typeReachesValidationRules(field.resolvedType, nextAncestors))
  ));
}

function collectRequestTypes(services) {
  const requestTypeByMethod = new Map();
  const servicesByPackage = new Map();

  for (const service of services) {
    const packageName = normalizedTypeName(service.parent);
    const packageServices = servicesByPackage.get(packageName) ?? [];
    packageServices.push(service);
    servicesByPackage.set(packageName, packageServices);
  }

  for (const [packageName, packageServices] of servicesByPackage) {
    if (packageServices.length !== 1) {
      throw new Error(
        `Expected one generated service per package for ${packageName}; found ${packageServices.length}. `
        + 'Update the validator generator to disambiguate callbacks before adding another service.',
      );
    }

    const service = packageServices[0];
    const generatedPath = join(
      GENERATED_SERVER_ROOT,
      ...packageName.split('.'),
      'service_server.ts',
    );
    const generatedSource = readFileSync(generatedPath, 'utf8');
    const callbackMatches = [...generatedSource.matchAll(/validateRequest\("([^"]+)"/g)];
    for (const callbackMatch of callbackMatches) {
      const callbackName = callbackMatch[1];
      if (requestTypeByMethod.has(callbackName)) {
        throw new Error(
          `Generated validateRequest callback name collision: ${callbackName}. `
          + 'The sebuf callback is not service-qualified, so duplicate RPC method names would apply the wrong schema.',
        );
      }

      const bodyDeclarations = [...generatedSource
        .slice(0, callbackMatch.index)
        .matchAll(/const body(?:\s*:\s*([A-Za-z0-9_]+)\s*=|\s*=\s*await req\.json\(\)\s+as\s+([A-Za-z0-9_]+))/g)];
      const lastBodyDeclaration = bodyDeclarations.at(-1);
      const requestTypeName = lastBodyDeclaration?.[1] ?? lastBodyDeclaration?.[2];
      const requestType = service.methodsArray
        .map((method) => method.resolvedRequestType)
        .find((type) => type instanceof protobuf.Type && type.name === requestTypeName);
      if (!(requestType instanceof protobuf.Type)) {
        throw new Error(
          `Could not associate ${callbackName} in ${relative(ROOT, generatedPath)} `
          + `with generated request type ${requestTypeName ?? '(missing)'}.`,
        );
      }
      requestTypeByMethod.set(callbackName, requestType);
    }
  }

  const expectedValidatedTypes = services
    .flatMap((service) => service.methodsArray)
    .map((method) => method.resolvedRequestType)
    .filter((type) => type instanceof protobuf.Type && typeReachesValidationRules(type))
    .map((type) => normalizedTypeName(type))
    .sort();
  const callbackValidatedTypes = [...requestTypeByMethod.values()]
    .filter((type) => typeReachesValidationRules(type))
    .map((type) => normalizedTypeName(type))
    .sort();
  if (JSON.stringify(callbackValidatedTypes) !== JSON.stringify(expectedValidatedTypes)) {
    throw new Error(
      'The generated sebuf callbacks do not cover every RPC request type reachable from buf.validate rules. '
      + 'Runtime validation would be incomplete; update the server generator before continuing.',
    );
  }

  return requestTypeByMethod;
}

function collectReachableTypes(requestTypeByMethod) {
  const reachable = new Set();
  const queue = [...requestTypeByMethod.values()];

  while (queue.length > 0) {
    const type = queue.pop();
    if (reachable.has(type)) continue;
    reachable.add(type);
    for (const field of type.fieldsArray) {
      if (field.resolvedType instanceof protobuf.Type) queue.push(field.resolvedType);
    }
  }

  return reachable;
}

function collectValidatedTypes(reachable) {
  const validated = new Set(
    [...reachable].filter((type) => (
      type.fieldsArray.some((field) => Object.keys(validationOptions(field)).length > 0)
    )),
  );

  let changed = true;
  while (changed) {
    changed = false;
    for (const type of reachable) {
      if (validated.has(type)) continue;
      if (type.fieldsArray.some((field) => (
        field.resolvedType instanceof protobuf.Type && validated.has(field.resolvedType)
      ))) {
        validated.add(type);
        changed = true;
      }
    }
  }

  return validated;
}

function buildFieldRule(field) {
  const options = validationOptions(field);
  for (const rule of Object.keys(options)) {
    if (RESPONSE_ONLY_RULES.has(rule)) {
      throw new Error(
        `buf.validate rule ${rule} on request field ${field.parent.fullName}.${field.name} `
        + 'is response-only; extend the runtime validator before using it on a request.',
      );
    }
  }
  const enumType = field.resolvedType instanceof protobuf.Enum ? field.resolvedType : null;
  const rule = {
    kind: field.resolvedType instanceof protobuf.Type ? 'message' : enumType ? 'enum' : field.type,
  };

  if (field.repeated) rule.repeated = true;
  if (field.options?.proto3_optional === true) rule.optional = true;
  if (field.resolvedType instanceof protobuf.Type) {
    rule.messageType = normalizedTypeName(field.resolvedType);
  }
  if (enumType) {
    rule.enumValues = Object.keys(enumType.values);
  }
  if (field.type === 'int64') {
    rule.int64Encoding = field.options?.['(sebuf.http.int64_encoding)'] === 'INT64_ENCODING_NUMBER'
      ? 'number'
      : 'string';
  }

  const mappings = [
    ['required', 'required'],
    ['ignore', 'ignore'],
    ['string.len', 'stringLen'],
    ['string.min_len', 'stringMinLen'],
    ['string.max_len', 'stringMaxLen'],
    ['string.max_bytes', 'stringMaxBytes'],
    ['string.const', 'stringConst'],
    ['string.pattern', 'stringPattern'],
    ['int32.gte', 'numberGte'],
    ['int32.lte', 'numberLte'],
    ['int64.gte', 'numberGte'],
    ['int64.lte', 'numberLte'],
    ['double.gte', 'numberGte'],
    ['double.lte', 'numberLte'],
    ['enum.defined_only', 'enumDefinedOnly'],
    ['repeated.min_items', 'repeatedMinItems'],
    ['repeated.max_items', 'repeatedMaxItems'],
    ['repeated.items.string.min_len', 'stringMinLen'],
    ['repeated.items.string.max_bytes', 'stringMaxBytes'],
    ['repeated.items.string.pattern', 'stringPattern'],
  ];
  for (const [optionName, propertyName] of mappings) {
    if (Object.hasOwn(options, optionName)) rule[propertyName] = options[optionName];
  }

  if (enumType && Object.hasOwn(options, 'enum.not_in')) {
    const numericValues = Array.isArray(options['enum.not_in'])
      ? options['enum.not_in']
      : [options['enum.not_in']];
    const enumNameByNumber = new Map(
      Object.entries(enumType.values).map(([name, value]) => [value, name]),
    );
    rule.enumNotIn = numericValues.map((value) => {
      const name = enumNameByNumber.get(value);
      if (!name) {
        throw new Error(
          `Unknown enum.not_in value ${value} on ${field.parent.fullName}.${field.name}.`,
        );
      }
      return name;
    });
  }

  if (rule.ignore != null && rule.ignore !== 'IGNORE_IF_ZERO_VALUE') {
    throw new Error(
      `Unsupported buf.validate ignore mode ${rule.ignore} on ${field.parent.fullName}.${field.name}.`,
    );
  }
  if (rule.required && rule.ignore === 'IGNORE_IF_ZERO_VALUE') {
    throw new Error(
      `Contradictory required + IGNORE_IF_ZERO_VALUE rules on ${field.parent.fullName}.${field.name}.`,
    );
  }

  if (rule.stringPattern != null) {
    try {
      new RegExp(rule.stringPattern);
    } catch (error) {
      throw new Error(
        `Pattern on ${field.parent.fullName}.${field.name} is not supported by the JavaScript runtime: ${error.message}`,
      );
    }
  }

  return rule;
}

function buildMessageRules(requestTypeByMethod) {
  const reachable = collectReachableTypes(requestTypeByMethod);
  const validated = collectValidatedTypes(reachable);
  const requestTypes = new Set(requestTypeByMethod.values());
  const emittedTypes = new Set([...validated, ...requestTypes]);
  const messageRules = {};

  for (const type of [...emittedTypes].sort((a, b) => a.fullName.localeCompare(b.fullName))) {
    const fields = {};
    for (const field of type.fieldsArray) {
      const hasDirectRules = Object.keys(validationOptions(field)).length > 0;
      const reachesRules = field.resolvedType instanceof protobuf.Type
        && validated.has(field.resolvedType);
      if (!hasDirectRules && !reachesRules) continue;
      fields[field.name] = buildFieldRule(field);
    }
    messageRules[normalizedTypeName(type)] = { fields };
  }

  return messageRules;
}

function stableObjectFromMap(map, mapValue) {
  return Object.fromEntries(
    [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, mapValue(value)]),
  );
}

function renderGeneratedFile(requestTypeByMethod, messageRules, protoRuleCount) {
  const requestTypes = stableObjectFromMap(
    requestTypeByMethod,
    (type) => normalizedTypeName(type),
  );

  return `// Code generated by scripts/generate-request-validation.mjs. DO NOT EDIT.\n`
    + `// Source: proto/worldmonitor/**/*.proto buf.validate annotations.\n\n`
    + `export const GENERATED_PROTO_VALIDATION_RULE_COUNT = ${protoRuleCount};\n`
    + `export const GENERATED_REQUEST_METHOD_COUNT = ${requestTypeByMethod.size};\n\n`
    + `export const GENERATED_REQUEST_TYPES = ${JSON.stringify(requestTypes, null, 2)} as const;\n\n`
    + `export const GENERATED_MESSAGE_RULES = ${JSON.stringify(messageRules, null, 2)} as const;\n`;
}

const root = new protobuf.Root();
for (const protoPath of walkProtoFiles(PROTO_ROOT)) {
  protobuf.parse(readFileSync(protoPath, 'utf8'), root);
}
root.resolveAll();

const protoRuleCount = assertSupportedRules(root);
const requestTypeByMethod = collectRequestTypes(collectServices(root));
const messageRules = buildMessageRules(requestTypeByMethod);
const generated = renderGeneratedFile(requestTypeByMethod, messageRules, protoRuleCount);

if (CHECK_ONLY) {
  const current = readFileSync(OUTPUT, 'utf8');
  if (current !== generated) {
    console.error(`${relative(ROOT, OUTPUT)} is stale; run: node scripts/generate-request-validation.mjs`);
    process.exit(1);
  }
  console.log(
    `Request validation registry is current (${requestTypeByMethod.size} RPCs, ${protoRuleCount} proto rules).`,
  );
} else {
  writeFileSync(OUTPUT, generated);
  console.log(
    `Generated ${relative(ROOT, OUTPUT)} (${requestTypeByMethod.size} RPCs, ${protoRuleCount} proto rules).`,
  );
}
