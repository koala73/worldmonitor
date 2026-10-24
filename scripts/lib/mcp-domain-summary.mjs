// Discovery surfaces that quote the MCP domain list, and the transforms that
// render MCP_DOMAIN_SUMMARY (api/mcp/domains.ts) into them. Only the list is
// generated; the sentence around it stays hand-written per surface.
//
// Markdown and MDX bodies bound the list with one sentinel pair. JSON values
// bound it with a literal prefix and suffix that must each occur exactly once
// in the named value. Every malformed surface throws with its path, so a hand
// edit that drops an anchor fails `npm run product:facts` instead of drifting.
// server.json and the server card's top-level `description` are frozen
// registry surfaces and are deliberately absent from both tables.

export const MARKDOWN_DOMAIN_SURFACES = [
  { path: 'public/mcp-server.md', start: '<!-- mcp-domains:start -->', end: '<!-- mcp-domains:end -->' },
  { path: 'docs/mcp-quickstart.mdx', start: '{/* mcp-domains:start */}', end: '{/* mcp-domains:end */}' },
  { path: 'docs/mcp-overview.mdx', start: '{/* mcp-domains:start */}', end: '{/* mcp-domains:end */}' },
];

export const SERVER_CARD_DOMAIN_SURFACE = {
  path: 'public/.well-known/mcp/server-card.json',
  valuePath: ['serverInfo', 'description'],
  prefix: 'briefs in these domains: ',
  suffix: '.',
};

export const AGENT_CARD_DOMAIN_SURFACE = {
  path: 'public/.well-known/agent-card.json',
  valuePath: ['description'],
  prefix: 'the data you need (',
  suffix: ') and it routes you',
};

export const JSON_DOMAIN_SURFACES = [
  SERVER_CARD_DOMAIN_SURFACE,
  {
    path: 'public/.well-known/ai-catalog.json',
    valuePath: ['entries', { identifier: 'urn:air:worldmonitor.app:mcp:worldmonitor' }, 'description'],
    prefix: 'briefs in these domains: ',
    suffix: '.',
  },
  {
    path: 'public/agent-view.json',
    valuePath: ['description'],
    prefix: 'in these domains: ',
    suffix: '. On-demand NLP utilities',
  },
  AGENT_CARD_DOMAIN_SURFACE,
];

function countOf(haystack, needle) {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

export function formatValuePath(valuePath) {
  return valuePath
    .map((segment, index) => {
      if (typeof segment === 'string') return index === 0 ? segment : `.${segment}`;
      const [key, value] = Object.entries(segment)[0];
      return `[${key}=${value}]`;
    })
    .join('');
}

export function readValueAt(doc, surface) {
  const where = `${surface.path} ${formatValuePath(surface.valuePath)}`;
  let node = doc;
  for (const segment of surface.valuePath) {
    if (typeof segment === 'string') {
      node = node && typeof node === 'object' ? node[segment] : undefined;
      continue;
    }
    const [key, value] = Object.entries(segment)[0];
    const matches = Array.isArray(node) ? node.filter((item) => item?.[key] === value) : [];
    if (matches.length !== 1) throw new Error(`${where}: expected exactly one entry with ${key}=${value}, found ${matches.length}`);
    node = matches[0];
  }
  if (typeof node !== 'string') throw new Error(`${where}: expected a string value`);
  return node;
}

export function renderMarkdownDomainSurface(source, surface, summary) {
  const starts = countOf(source, surface.start);
  const ends = countOf(source, surface.end);
  const startAt = source.indexOf(surface.start);
  const endAt = source.indexOf(surface.end);
  if (starts !== 1 || ends !== 1 || endAt < startAt) {
    throw new Error(
      `${surface.path}: expected exactly one ${surface.start}…${surface.end} pair, found ${starts} start and ${ends} end`,
    );
  }
  return `${source.slice(0, startAt + surface.start.length)}${summary}${source.slice(endAt)}`;
}

function renderDomainSpan(value, surface, summary) {
  const where = `${surface.path} ${formatValuePath(surface.valuePath)}`;
  const prefixes = countOf(value, surface.prefix);
  const suffixes = countOf(value, surface.suffix);
  const prefixAt = value.indexOf(surface.prefix);
  const suffixAt = value.indexOf(surface.suffix);
  if (prefixes !== 1 || suffixes !== 1 || suffixAt < prefixAt + surface.prefix.length) {
    throw new Error(
      `${where}: expected prefix ${JSON.stringify(surface.prefix)} then suffix ${JSON.stringify(surface.suffix)} exactly once each, found ${prefixes} and ${suffixes}`,
    );
  }
  return `${value.slice(0, prefixAt + surface.prefix.length)}${summary}${value.slice(suffixAt)}`;
}

// Replaces the value's encoded string in place so a hand-formatted file keeps
// its layout. The encoded old value must occur exactly once in the file.
export function renderJsonDomainSurface(source, surface, summary) {
  const where = `${surface.path} ${formatValuePath(surface.valuePath)}`;
  const current = readValueAt(JSON.parse(source), surface);
  const next = renderDomainSpan(current, surface, summary);
  if (next === current) return source;
  const encoded = JSON.stringify(current);
  if (countOf(source, encoded) !== 1) {
    throw new Error(`${where}: the encoded value must occur exactly once in the file`);
  }
  return source.replace(encoded, () => JSON.stringify(next));
}
