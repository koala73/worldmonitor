// The MCP tools reference is an index (docs/mcp-tools-reference.mdx) plus one
// focused page per category (docs/mcp-tools/*.mdx), split so each page fits an
// agent's context window. Tests that check per-tool sections read the whole
// set as one text: the category pages in index order, then the index.
import { readFileSync, readdirSync } from 'node:fs';

const DOCS = new URL('../../docs/', import.meta.url);

export function toolsReferencePagePaths(lang = 'en') {
  const prefix = lang === 'zh' ? 'zh/' : '';
  const index = readFileSync(new URL(`${prefix}mcp-tools-reference.mdx`, DOCS), 'utf8');
  const linked = [...index.matchAll(new RegExp(`\\]\\(/${prefix}mcp-tools/([a-z0-9-]+)[)#]`, 'g'))].map((m) => m[1]);
  const ordered = [...new Set(linked)];
  const onDisk = readdirSync(new URL(`${prefix}mcp-tools/`, DOCS)).filter((f) => f.endsWith('.mdx')).map((f) => f.slice(0, -4));
  const unlinked = onDisk.filter((slug) => !ordered.includes(slug));
  if (unlinked.length) throw new Error(`${prefix}mcp-tools-reference.mdx does not link ${unlinked.join(', ')}`);
  return [
    ...ordered.map((slug) => `docs/${prefix}mcp-tools/${slug}.mdx`),
    `docs/${prefix}mcp-tools-reference.mdx`,
  ];
}

export function readToolsReference(lang = 'en') {
  return toolsReferencePagePaths(lang)
    .map((path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'))
    .join('\n');
}
