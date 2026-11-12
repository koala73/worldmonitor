/**
 * Bing Webmaster Tools flags docs pages whose meta description is too short.
 * Mintlify uses an mdx page's frontmatter description as its meta description,
 * and an API reference page's operation description (generated from the proto
 * RPC comment by `make generate`) as its own.
 * Lengths are JS string.length, which is also how Bing counts Chinese
 * characters.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';

const ROOT = new URL('../', import.meta.url).pathname;
const DOCS_DIR = join(ROOT, 'docs');
const OPENAPI_YAML = join(DOCS_DIR, 'api/worldmonitor.openapi.yaml');
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const MIN_LENGTH = 110;

function frontmatterFields(content) {
  const block = content.match(/^---\n([\s\S]*?\n)?---\n/)?.[1] ?? '';
  return parseYaml(block) ?? {};
}

function collectMdx(dir, found = []) {
  for (const entry of readdirSync(dir).sort()) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) collectMdx(abs, found);
    else if (entry.endsWith('.mdx')) found.push(abs);
  }
  return found;
}

function formatOffenders(offenders) {
  return offenders.map(({ id, length }) => `  ${length}\t${id}`).join('\n');
}

describe('docs meta description length', () => {
  it(`every docs mdx frontmatter description is at least ${MIN_LENGTH} characters`, () => {
    const offenders = [];
    for (const file of collectMdx(DOCS_DIR)) {
      const { description } = frontmatterFields(readFileSync(file, 'utf8'));
      if (typeof description !== 'string') continue;
      if (description.length < MIN_LENGTH) {
        offenders.push({ id: relative(ROOT, file), length: description.length });
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `${offenders.length} mdx description(s) under ${MIN_LENGTH} characters:\n${formatOffenders(offenders)}`,
    );
  });

  it(`every API reference operation description is at least ${MIN_LENGTH} characters`, () => {
    const spec = parseYaml(readFileSync(OPENAPI_YAML, 'utf8'));
    const offenders = [];
    for (const pathItem of Object.values(spec.paths ?? {})) {
      for (const [method, operation] of Object.entries(pathItem ?? {})) {
        if (!HTTP_METHODS.has(method)) continue;
        const length = String(operation?.description ?? '').length;
        if (length < MIN_LENGTH) offenders.push({ id: operation?.operationId, length });
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `${offenders.length} operation description(s) under ${MIN_LENGTH} characters; edit the proto RPC comment and run make generate:\n${formatOffenders(offenders)}`,
    );
  });
});
