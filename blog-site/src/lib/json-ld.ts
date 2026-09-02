/**
 * The single serialisation seam for every JSON-LD block blog-site emits.
 *
 * blog-site is a separate live JSON-LD emitter from the crawlable corpus: the
 * #7502 sweep in tests/crawlable-corpus.test.mjs walks built corpus output and
 * asserts a resolvable `@context` on every block, and `use-cases` / `research`
 * ride along only because buildCrawlableCorpus writes them into the same
 * outDir. Nothing covered blog-site, whose eleven producers each hand-wrote
 * their own `"@context": "https://schema.org"` — so a block that simply omitted
 * it would have shipped silently and been ignored by every consumer (#7530).
 *
 * Every producer now passes through here, and a missing or unresolvable
 * `@context` is stamped rather than published broken. Blocks that legitimately
 * carry a richer context (an array, or an object with an `@vocab`) keep it.
 */

export const SCHEMA_ORG_CONTEXT = 'https://schema.org';

const SCHEMA_ORG_CONTEXT_URLS = new Set(['https://schema.org', 'http://schema.org']);

/**
 * Mirrors jsonLdContextIsResolvable in tests/crawlable-corpus.test.mjs: a
 * context resolves when it is the schema.org URL, an array containing one, or
 * an object whose `@vocab` is one. Nested nodes inherit the top-level context,
 * so only the top level is checked.
 */
export function jsonLdContextIsResolvable(context: unknown): boolean {
  if (typeof context === 'string') {
    return SCHEMA_ORG_CONTEXT_URLS.has(context.replace(/\/$/, ''));
  }
  if (Array.isArray(context)) return context.some((entry) => jsonLdContextIsResolvable(entry));
  if (context && typeof context === 'object') {
    return jsonLdContextIsResolvable((context as Record<string, unknown>)['@vocab']);
  }
  return false;
}

/**
 * Returns the node with a resolvable `@context`. An unresolvable one is
 * replaced, not merged around: spreading the node after the stamp would let its
 * own broken value win, which is the case this exists to prevent.
 */
export function withSchemaContext<T extends Record<string, unknown>>(node: T): T {
  if (jsonLdContextIsResolvable(node['@context'])) return node;
  const { '@context': unresolvable, ...rest } = node;
  void unresolvable;
  return { '@context': SCHEMA_ORG_CONTEXT, ...rest } as unknown as T;
}

/**
 * Serialise a JSON-LD node for `set:html`. `<` is escaped so a string value
 * containing `</script>` cannot close the block early.
 */
export function stringifyJsonLd(value: Record<string, unknown>): string {
  return JSON.stringify(withSchemaContext(value)).replace(/</g, '\\u003c');
}
