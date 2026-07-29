import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards two OpenAPI completeness invariants restored by the #4599 follow-ups:
//   C - every generated operation carries a non-empty description (the sebuf
//       generator emits it from the RPC's leading proto comment; 10 RPCs had none).
//   D - an operation is marked deprecated: true (injected by
//       scripts/openapi-inject-deprecated.mjs from the proto option deprecated)
//       iff its description marks it DISABLED. The DISABLED prose and the
//       deprecated flag are two independent signals that must agree, so a regen
//       that drops the injector - or a proto that gains one signal but not the
//       other - fails here.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');
const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head']);
const YAML_METHOD_RE = /^ {8}(get|post|put|delete|patch|options|head):\s*$/;

const jsonServiceSpecs = readdirSync(apiDir)
  .filter((f) => /Service\.openapi\.json$/.test(f))
  .sort();
const yamlSpecs = readdirSync(apiDir)
  .filter((f) => /Service\.openapi\.yaml$/.test(f) || f === 'worldmonitor.openapi.yaml')
  .sort();

function openApiArtifacts() {
  return [
    ...jsonServiceSpecs.map((file) => ({
      family: 'json',
      file,
      entries: jsonOperationEntries(JSON.parse(readFileSync(resolve(apiDir, file), 'utf8'))),
    })),
    ...yamlSpecs.map((file) => ({
      family: file === 'worldmonitor.openapi.yaml' ? 'bundle' : 'yaml',
      file,
      entries: yamlOperationEntries(readFileSync(resolve(apiDir, file), 'utf8')),
    })),
  ];
}

function jsonOperationEntries(spec) {
  const entries = [];
  for (const [path, ops] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(ops ?? {})) {
      if (!HTTP_METHODS.has(method) || !op || typeof op !== 'object') continue;
      entries.push({ path, method, description: op.description, deprecated: op.deprecated === true });
    }
  }
  return entries;
}

function yamlOperationEntries(text) {
  const entries = [];
  const lines = text.split('\n');
  let currentPath = null;
  for (let i = 0; i < lines.length; i++) {
    const pathMatch = lines[i].match(/^ {4}(\/\S+):\s*$/);
    if (pathMatch) {
      currentPath = pathMatch[1];
      continue;
    }
    if (/^\S/.test(lines[i])) currentPath = null;

    const methodMatch = lines[i].match(YAML_METHOD_RE);
    if (!currentPath || !methodMatch) continue;

    let description = '';
    let deprecated = false;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^ {0,8}\S/.test(lines[j])) break;
      const descriptionMatch = lines[j].match(/^ {12}description:\s*(.*)$/);
      if (descriptionMatch) {
        description = readYamlDescription(lines, j, descriptionMatch[1]);
      }
      const deprecatedMatch = lines[j].match(/^ {12}deprecated:\s*(true|false)\s*$/);
      if (deprecatedMatch) deprecated = deprecatedMatch[1] === 'true';
    }
    entries.push({ path: currentPath, method: methodMatch[1], description, deprecated });
  }
  return entries;
}

function readYamlDescription(lines, index, rest) {
  const trimmed = rest.trim();
  if (trimmed && trimmed !== '|' && trimmed !== '|-' && trimmed !== '>' && trimmed !== '>-') {
    return trimmed.replace(/^['"]|['"]$/g, '');
  }
  const body = [];
  for (let i = index + 1; i < lines.length; i++) {
    if (lines[i].trim() && !lines[i].startsWith('                ')) break;
    body.push(lines[i].trim());
  }
  return body.join('\n').trim();
}

describe('OpenAPI deprecated + operation-description contract', () => {
  it('gives every operation a non-empty description in every artifact', () => {
    const missing = [];
    for (const { file, entries } of openApiArtifacts()) {
      for (const { path, method, description } of entries) {
        if (!(description ?? '').trim()) missing.push(file + ' ' + method.toUpperCase() + ' ' + path);
      }
    }
    assert.deepEqual(missing, [], 'operations missing a description:\n' + missing.join('\n'));
  });

  it('marks an operation deprecated iff it is documented DISABLED, in every artifact', () => {
    const deprecatedByFamily = new Map([
      ['json', 0],
      ['yaml', 0],
      ['bundle', 0],
    ]);

    for (const { family, file, entries } of openApiArtifacts()) {
      for (const { path, method, description, deprecated } of entries) {
        const label = file + ' ' + method.toUpperCase() + ' ' + path;
        const isDisabled = /\bDISABLED\b/.test(description ?? '');
        assert.equal(
          deprecated,
          isDisabled,
          label + ': deprecated=' + deprecated + ' but DISABLED-in-description=' + isDisabled + ' - the two signals must agree',
        );
        if (deprecated) deprecatedByFamily.set(family, deprecatedByFamily.get(family) + 1);
      }
    }

    // The injector canary: each artifact family must carry exactly as many
    // deprecated operations as the proto sources declare. A regen that drops
    // scripts/openapi-inject-deprecated.mjs fails here whenever any RPC is
    // deprecated; with zero declared (the state since #5695 re-enabled the two
    // company RPCs) every family must also carry zero.
    const declared = countDeprecatedRpcDeclarations();
    assert.equal(deprecatedByFamily.get('json'), declared, 'JSON specs must carry exactly the proto-declared deprecated operations');
    assert.equal(deprecatedByFamily.get('yaml'), declared, 'service YAML specs must carry exactly the proto-declared deprecated operations');
    assert.equal(deprecatedByFamily.get('bundle'), declared, 'the bundled YAML spec must carry exactly the proto-declared deprecated operations');
  });

  it('propagates deprecated corporate-intelligence fields to every generated contract', () => {
    const json = JSON.parse(readFileSync(resolve(apiDir, 'IntelligenceService.openapi.json'), 'utf8'));
    const enrichment = json.components.schemas.GetCompanyEnrichmentResponse.properties;
    const company = json.components.schemas.EnrichedCompany.properties;
    const signals = json.components.schemas.ListCompanySignalsResponse.properties;
    assert.equal(json.components.schemas.GetCompanyEnrichmentRequest.properties.domain.deprecated, true);
    assert.equal(enrichment.github.deprecated, true);
    assert.equal(enrichment.techStack.deprecated, true);
    assert.equal(enrichment.hackerNewsMentions.deprecated, true);
    assert.equal(company.founded.deprecated, true);
    assert.equal(signals.domain.deprecated, true);

    for (const path of [
      '/api/intelligence/v1/get-company-enrichment',
      '/api/intelligence/v1/list-company-signals',
    ]) {
      const domain = json.paths[path].get.parameters.find(parameter => parameter.name === 'domain');
      assert.equal(domain?.deprecated, true, `${path} domain query param must be machine-readable as deprecated`);
    }

    for (const file of ['IntelligenceService.openapi.yaml', 'worldmonitor.openapi.yaml']) {
      const yaml = readFileSync(resolve(apiDir, file), 'utf8');
      const responseBlock = yamlSchemaBlock(yaml, 'GetCompanyEnrichmentResponse');
      assert.match(responseBlock, /^\s{16}github:\n\s{20}deprecated: true/m, `${file} github field`);
      assert.match(responseBlock, /^\s{16}techStack:\n\s{20}deprecated: true/m, `${file} techStack field`);
      assert.match(responseBlock, /^\s{16}hackerNewsMentions:\n\s{20}deprecated: true/m, `${file} HN field`);
      assert.match(yamlSchemaBlock(yaml, 'EnrichedCompany'), /^\s{16}founded:\n\s{20}deprecated: true/m, `${file} founded field`);
      assert.match(yamlSchemaBlock(yaml, 'ListCompanySignalsResponse'), /^\s{16}domain:\n\s{20}deprecated: true/m, `${file} signal domain field`);
      assert.match(
        yamlPathBlock(yaml, '/api/intelligence/v1/get-company-enrichment'),
        /^\s{16}- name: domain\n\s{18}deprecated: true/m,
        `${file} enrichment domain query`,
      );
      assert.match(
        yamlPathBlock(yaml, '/api/intelligence/v1/list-company-signals'),
        /^\s{16}- name: domain\n\s{18}deprecated: true/m,
        `${file} signals domain query`,
      );
    }

    for (const family of ['client', 'server']) {
      const generated = readFileSync(
        resolve(root, `src/generated/${family}/worldmonitor/intelligence/v1/service_${family}.ts`),
        'utf8',
      );
      assert.match(generated, /export interface GetCompanyEnrichmentRequest \{\n  \/\*\* @deprecated \*\/\n  domain: string;/);
      assert.match(generated, /export interface GetCompanyEnrichmentResponse \{[\s\S]*?  \/\*\* @deprecated \*\/\n  github\?: EnrichedGithub;/);
      assert.match(generated, /export interface EnrichedCompany \{[\s\S]*?  \/\*\* @deprecated \*\/\n  founded: number;/);
      assert.match(generated, /export interface ListCompanySignalsResponse \{[\s\S]*?  \/\*\* @deprecated \*\/\n  domain: string;/);
    }
  });

  it('keeps the enrichment example truthful about deprecated compatibility fields', () => {
    const json = JSON.parse(readFileSync(resolve(apiDir, 'IntelligenceService.openapi.json'), 'utf8'));
    const media = json.paths['/api/intelligence/v1/get-company-enrichment'].get.responses['200'].content['application/json'];
    const example = media.example;
    assert.equal(example.company.founded, 0);
    assert.equal('github' in example, false);
    assert.deepEqual(example.techStack, []);
    assert.deepEqual(example.hackerNewsMentions, []);
    assert.ok(example.secFilings.recentFilings[0].items.length > 0);
  });
});

function yamlSchemaBlock(text, name) {
  const match = new RegExp(`\\n {8}(?:[A-Za-z0-9]+_)*${name}:\\n`).exec(text);
  const start = match?.index ?? -1;
  assert.notEqual(start, -1, `missing YAML schema ${name}`);
  const remainder = text.slice(start + 1);
  const next = remainder.slice(1).search(/\n {8}\w+:\n/);
  return next === -1 ? remainder : remainder.slice(0, next + 1);
}

function yamlPathBlock(text, path) {
  const start = text.indexOf(`\n    ${path}:\n`);
  assert.notEqual(start, -1, `missing YAML path ${path}`);
  const remainder = text.slice(start + 1);
  const next = remainder.slice(1).search(/\n {4}\/\S+:\n/);
  return next === -1 ? remainder : remainder.slice(0, next + 1);
}

// Counts `option deprecated = true;` declarations inside rpc bodies across all
// service protos — the single upstream source both the sebuf generator and the
// deprecated-flag injector read.
function countDeprecatedRpcDeclarations() {
  let count = 0;
  for (const file of walkProtoFiles(resolve(root, 'proto/worldmonitor'))) {
    const text = readFileSync(file, 'utf8');
    count += (text.match(/^\s*option\s+deprecated\s*=\s*true\s*;/gm) ?? []).length;
  }
  return count;
}

function walkProtoFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkProtoFiles(full));
    else if (name.endsWith('.proto')) out.push(full);
  }
  return out;
}
