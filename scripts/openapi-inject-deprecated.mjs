#!/usr/bin/env node
/**
 * Propagate proto deprecation metadata into generated OpenAPI and TypeScript.
 *
 * sebuf v0.11.1 omits both RPC `option deprecated = true` and field
 * `[deprecated = true]` metadata. This idempotent post-generator treats proto
 * as the source of truth and patches:
 *   - OpenAPI operation, query-parameter, and component-property flags
 *   - generated client/server interface fields with `/** @deprecated *\/`
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serialize } from './lib/openapi-codegen.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');
const protoDir = resolve(root, 'proto/worldmonitor');
const CHECK = process.argv.includes('--check');
const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head']);

function walkFiles(dir, predicate) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, predicate));
    else if (predicate(entry.name)) out.push(full);
  }
  return out;
}

function lowerCamel(name) {
  return name.replace(/_([a-z0-9])/g, (_match, char) => char.toUpperCase());
}

function joinOpenApiPath(basePath, rpcPath) {
  if (!basePath) return rpcPath;
  if (rpcPath === basePath || rpcPath.startsWith(basePath + '/')) return rpcPath;
  return basePath.replace(/\/+$/, '') + '/' + rpcPath.replace(/^\/+/, '');
}

function readProtoDeprecations() {
  const deprecatedPaths = new Set();
  const deprecatedFields = new Map();
  const requestByOperationId = new Map();

  for (const file of walkFiles(protoDir, name => name.endsWith('.proto'))) {
    const src = readFileSync(file, 'utf8');

    // Top-level message bodies end at a column-zero brace in this corpus.
    for (const message of src.matchAll(/^message\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
      const [, messageName, body] = message;
      const fields = new Map();
      for (const field of body.matchAll(
        /^\s*(?:repeated\s+)?(?:map<[^>]+>|[\w.]+)\s+(\w+)\s*=\s*\d+\s*\[([^\]]*\bdeprecated\s*=\s*true[^\]]*)\]\s*;/gm,
      )) {
        const [, protoName, options] = field;
        const jsonName = lowerCamel(protoName);
        const queryName = options.match(/\(sebuf\.http\.query\)\s*=\s*\{\s*name:\s*"([^"]+)"/)?.[1] ?? jsonName;
        fields.set(jsonName, { queryName });
      }
      if (fields.size > 0) deprecatedFields.set(messageName, fields);
    }

    if (!file.endsWith('/service.proto')) continue;
    const serviceConfig = src.match(/\(sebuf\.http\.service_config\)\s*=\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    const basePath = serviceConfig.match(/\bbase_path:\s*"([^"]+)"/)?.[1] ?? '';
    for (const rpc of src.matchAll(
      /\brpc\s+(\w+)\s*\(\s*([\w.]+)\s*\)\s*returns\s*\([^)]*\)\s*\{([\s\S]*?)\n\s{2}\}/g,
    )) {
      const [, operationId, requestTypeRaw, body] = rpc;
      const requestType = requestTypeRaw.split('.').pop();
      requestByOperationId.set(operationId, requestType);
      if (!/option\s+deprecated\s*=\s*true\s*;/.test(body)) continue;
      const path = body.match(/path:\s*"([^"]+)"/)?.[1];
      if (path) deprecatedPaths.add(joinOpenApiPath(basePath, path));
    }
  }

  return { deprecatedPaths, deprecatedFields, requestByOperationId };
}

const {
  deprecatedPaths: DEPRECATED_PATHS,
  deprecatedFields: DEPRECATED_FIELDS,
  requestByOperationId: REQUEST_BY_OPERATION_ID,
} = readProtoDeprecations();

function deprecatedQueryNames(operationId) {
  const requestType = REQUEST_BY_OPERATION_ID.get(operationId);
  const fields = DEPRECATED_FIELDS.get(requestType);
  return new Set(fields ? [...fields.values()].map(field => field.queryName) : []);
}

function deprecatedFieldsForSchema(schemaName) {
  const exact = DEPRECATED_FIELDS.get(schemaName);
  if (exact) return exact;
  for (const [messageName, fields] of DEPRECATED_FIELDS) {
    if (schemaName.endsWith(`_${messageName}`)) return fields;
  }
  return null;
}

function injectJson(spec) {
  let changed = false;
  for (const [path, ops] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(ops)) {
      if (!HTTP_METHODS.has(method) || !op || typeof op !== 'object') continue;
      const operationDeprecated = DEPRECATED_PATHS.has(path);
      if (operationDeprecated && op.deprecated !== true) {
        op.deprecated = true;
        changed = true;
      } else if (!operationDeprecated && op.deprecated !== undefined) {
        delete op.deprecated;
        changed = true;
      }

      const queryNames = deprecatedQueryNames(op.operationId);
      for (const parameter of op.parameters ?? []) {
        if (!parameter || parameter.in !== 'query' || !queryNames.has(parameter.name)) continue;
        if (parameter.deprecated !== true) {
          parameter.deprecated = true;
          changed = true;
        }
      }
    }
  }

  for (const [messageName, fields] of DEPRECATED_FIELDS) {
    const properties = spec.components?.schemas?.[messageName]?.properties;
    if (!properties) continue;
    for (const fieldName of fields.keys()) {
      const property = properties[fieldName];
      if (property && property.deprecated !== true) {
        property.deprecated = true;
        changed = true;
      }
    }
  }
  return changed;
}

function ensureYamlFlag(lines, index, indent) {
  const flag = `${' '.repeat(indent)}deprecated: true`;
  for (let cursor = index + 1; cursor < lines.length; cursor++) {
    if (lines[cursor].trim() && lines[cursor].search(/\S/) <= indent - 2) break;
    if (lines[cursor].trim().startsWith('deprecated:')) {
      if (lines[cursor] === flag) return false;
      lines[cursor] = flag;
      return true;
    }
  }
  lines.splice(index + 1, 0, flag);
  return true;
}

function injectYaml(text) {
  const lines = text.split('\n');
  let changed = false;
  let currentPath = null;
  let currentOperationId = '';
  let currentSchema = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const pathMatch = line.match(/^ {4}(\/\S+):\s*$/);
    if (pathMatch) {
      currentPath = pathMatch[1];
      currentOperationId = '';
      continue;
    }
    if (/^\S/.test(line)) {
      currentPath = null;
      currentOperationId = '';
    }

    const methodMatch = line.match(/^ {8}([a-z]+):\s*$/);
    if (methodMatch && currentPath && HTTP_METHODS.has(methodMatch[1])) {
      if (DEPRECATED_PATHS.has(currentPath)) {
        changed = ensureYamlFlag(lines, i, 12) || changed;
        if (changed && lines[i + 1]?.trim() === 'deprecated: true') i++;
      }
      continue;
    }

    const operationMatch = line.match(/^ {12}operationId:\s*"?([^"]+)"?\s*$/);
    if (operationMatch) {
      currentOperationId = operationMatch[1];
      continue;
    }
    const parameterMatch = line.match(/^ {16}- name:\s*"?([^"]+)"?\s*$/);
    if (parameterMatch && deprecatedQueryNames(currentOperationId).has(parameterMatch[1])) {
      changed = ensureYamlFlag(lines, i, 18) || changed;
      if (lines[i + 1]?.trim() === 'deprecated: true') i++;
      continue;
    }

    const schemaMatch = line.match(/^ {8}(\w+):\s*$/);
    if (schemaMatch) {
      currentSchema = schemaMatch[1];
      continue;
    }
    const propertyMatch = line.match(/^ {16}(\w+):\s*$/);
    if (propertyMatch && deprecatedFieldsForSchema(currentSchema)?.has(propertyMatch[1])) {
      changed = ensureYamlFlag(lines, i, 20) || changed;
      if (lines[i + 1]?.trim() === 'deprecated: true') i++;
    }
  }
  return { text: lines.join('\n'), changed };
}

function injectTypeScript(text) {
  const lines = text.split('\n');
  let changed = false;
  let currentInterface = '';
  for (let i = 0; i < lines.length; i++) {
    const interfaceMatch = lines[i].match(/^export interface (\w+) \{$/);
    if (interfaceMatch) {
      currentInterface = interfaceMatch[1];
      continue;
    }
    if (currentInterface && lines[i] === '}') {
      currentInterface = '';
      continue;
    }
    const fieldMatch = lines[i].match(/^ {2}(\w+)\??:/);
    if (!fieldMatch || !DEPRECATED_FIELDS.get(currentInterface)?.has(fieldMatch[1])) continue;
    if (lines[i - 1] !== '  /** @deprecated */') {
      lines.splice(i, 0, '  /** @deprecated */');
      changed = true;
      i++;
    }
  }
  return { text: lines.join('\n'), changed };
}

const jsonFiles = readdirSync(apiDir).filter(file => /Service\.openapi\.json$/.test(file)).sort();
const yamlFiles = readdirSync(apiDir)
  .filter(file => /Service\.openapi\.yaml$/.test(file) || file === 'worldmonitor.openapi.yaml')
  .sort();
const tsFiles = [
  ...walkFiles(resolve(root, 'src/generated/client'), name => name.endsWith('.ts')),
  ...walkFiles(resolve(root, 'src/generated/server'), name => name.endsWith('.ts')),
].sort();

let wouldChange = 0;
const touched = [];

for (const file of jsonFiles) {
  const path = resolve(apiDir, file);
  const spec = JSON.parse(readFileSync(path, 'utf8'));
  if (!injectJson(spec)) continue;
  wouldChange++;
  touched.push(file);
  if (!CHECK) writeFileSync(path, serialize(spec));
}

for (const file of yamlFiles) {
  const path = resolve(apiDir, file);
  const result = injectYaml(readFileSync(path, 'utf8'));
  if (!result.changed) continue;
  wouldChange++;
  touched.push(file);
  if (!CHECK) writeFileSync(path, result.text);
}

for (const path of tsFiles) {
  const result = injectTypeScript(readFileSync(path, 'utf8'));
  if (!result.changed) continue;
  wouldChange++;
  touched.push(path.replace(root + '/', ''));
  if (!CHECK) writeFileSync(path, result.text);
}

const fieldCount = [...DEPRECATED_FIELDS.values()].reduce((sum, fields) => sum + fields.size, 0);
if (CHECK) {
  if (wouldChange > 0) {
    console.error(`✗ ${wouldChange} generated artifact(s) missing deprecation metadata: ${touched.join(', ')}`);
    console.error('  Run: npm run gen:openapi:deprecated');
    process.exit(1);
  }
  console.log(`✓ deprecation metadata in sync (${DEPRECATED_PATHS.size} RPC path(s), ${fieldCount} field(s))`);
} else {
  console.log(`openapi-inject-deprecated: updated ${wouldChange} artifact(s) — ${DEPRECATED_PATHS.size} RPC path(s), ${fieldCount} field(s)`);
}
