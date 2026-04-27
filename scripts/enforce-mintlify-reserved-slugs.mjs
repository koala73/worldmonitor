#!/usr/bin/env node
/**
 * Mintlify reserves /mcp and /authed/mcp for its auto-generated docs-as-MCP
 * server. A user-authored docs page at either slug is silently shadowed by
 * the MCP JSON-RPC handler — adjacent pages render fine, only the reserved
 * slug 504s. There is no opt-out per Mintlify's docs.
 * https://mintlify.com/docs/ai/model-context-protocol
 */

import { existsSync, readFileSync } from 'fs';

const RESERVED = new Set(['mcp', 'authed/mcp']);
const DOCS_JSON = 'docs/docs.json';
const RESERVED_FILES = ['docs/mcp.mdx', 'docs/authed/mcp.mdx'];

const violations = [];

for (const file of RESERVED_FILES) {
  if (existsSync(file)) {
    violations.push(`${file}: file uses a slug reserved by Mintlify (rename, e.g. mcp-server.mdx)`);
  }
}

if (existsSync(DOCS_JSON)) {
  const json = JSON.parse(readFileSync(DOCS_JSON, 'utf8'));
  const seen = [];
  const walk = (node, path) => {
    if (typeof node === 'string') {
      if (RESERVED.has(node)) seen.push({ slug: node, path });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(json, '');
  for (const { slug, path } of seen) {
    violations.push(`${DOCS_JSON} ${path}: nav entry "${slug}" is reserved by Mintlify (rename to e.g. "mcp-server")`);
  }
}

if (violations.length > 0) {
  console.error('Mintlify reserved-slug check FAILED:');
  console.error('  Mintlify owns /mcp and /authed/mcp for its auto-generated docs-as-MCP server.');
  console.error('  Pages at these slugs are shadowed at request time — see');
  console.error('  https://mintlify.com/docs/ai/model-context-protocol');
  console.error('');
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

console.log('Mintlify reserved-slug check passed.');
