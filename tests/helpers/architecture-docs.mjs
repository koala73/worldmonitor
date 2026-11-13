// The English architecture guide is an index (docs/architecture.mdx) plus one
// focused page per topic (docs/architecture-topics/*.mdx), split so each page
// fits an agent's context window. Tests that check what the guide says read the
// whole set as one text: the topic pages in name order, then the index.
import { readFileSync, readdirSync } from 'node:fs';

const DOCS = new URL('../../docs/', import.meta.url);

export function architecturePagePaths() {
  const index = readFileSync(new URL('architecture.mdx', DOCS), 'utf8');
  const onDisk = readdirSync(new URL('architecture-topics/', DOCS)).filter((f) => f.endsWith('.mdx')).sort();
  const unlinked = onDisk.filter((f) => !index.includes(`](/architecture-topics/${f.slice(0, -4)})`));
  if (unlinked.length) throw new Error(`docs/architecture.mdx does not link ${unlinked.join(', ')}`);
  return [...onDisk.map((f) => `docs/architecture-topics/${f}`), 'docs/architecture.mdx'];
}

export function readArchitectureGuide() {
  return architecturePagePaths()
    .map((path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'))
    .join('\n');
}
