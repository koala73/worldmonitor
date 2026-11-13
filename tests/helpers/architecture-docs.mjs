// The architecture guide is an index (docs/architecture.mdx) plus one focused
// page per topic (docs/architecture-topics/*.mdx), split so each page fits an
// agent's context window; docs/zh/ mirrors the layout. Tests that check what
// the guide says read the whole set as one text: the topic pages in name
// order, then the index.
import { readFileSync, readdirSync } from 'node:fs';

const DOCS = new URL('../../docs/', import.meta.url);

export function architecturePagePaths(lang = 'en') {
  const prefix = lang === 'zh' ? 'zh/' : '';
  const index = readFileSync(new URL(`${prefix}architecture.mdx`, DOCS), 'utf8');
  const onDisk = readdirSync(new URL(`${prefix}architecture-topics/`, DOCS)).filter((f) => f.endsWith('.mdx')).sort();
  const unlinked = onDisk.filter((f) => !index.includes(`](/${prefix}architecture-topics/${f.slice(0, -4)})`));
  if (unlinked.length) throw new Error(`docs/${prefix}architecture.mdx does not link ${unlinked.join(', ')}`);
  return [...onDisk.map((f) => `docs/${prefix}architecture-topics/${f}`), `docs/${prefix}architecture.mdx`];
}

export function readArchitectureGuide(lang = 'en') {
  return architecturePagePaths(lang)
    .map((path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'))
    .join('\n');
}
