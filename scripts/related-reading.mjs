/**
 * "Related reading" links on generated country, crisis and comparison pages.
 *
 * scripts/data/related-reading.json maps a generated page path to at most three
 * blog posts or docs pages that discuss its subject. It is written by
 * `node scripts/internal-links.mjs related` (Jev picks from TF-IDF
 * candidates) and reviewed like any committed content. The corpus build reads
 * it here and fails on a link that no longer resolves, as chokepoint editorial
 * links do.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const RELATED_READING_PATH = 'scripts/data/related-reading.json';
export const MAX_RELATED_READING = 3;

const docsFileExists = (rootDir, href) => {
  const slug = href.slice('/docs/'.length);
  return ['.mdx', '.md'].some((ext) => existsSync(join(rootDir, 'docs', `${slug}${ext}`)));
};

/**
 * Page path -> [{ href, title }]. A missing file is an empty map. A page path
 * the build no longer generates is harmless (nothing renders it); a dead href
 * or a malformed entry throws.
 */
export function loadRelatedReading({ rootDir, blogPostPaths }) {
  const file = join(rootDir, RELATED_READING_PATH);
  if (!existsSync(file)) return new Map();
  const { pages = {} } = JSON.parse(readFileSync(file, 'utf8'));
  const out = new Map();
  for (const [path, items] of Object.entries(pages)) {
    if (!Array.isArray(items) || items.length > MAX_RELATED_READING) {
      throw new Error(`${RELATED_READING_PATH}: ${path} must list 1-${MAX_RELATED_READING} links`);
    }
    for (const item of items) {
      const href = item?.href;
      const resolves = typeof href === 'string'
        && (blogPostPaths.has(href) || (/^\/docs\/[a-z0-9][a-z0-9/-]*$/.test(href) && docsFileExists(rootDir, href)));
      if (!resolves || typeof item.title !== 'string' || !item.title.trim()) {
        throw new Error(`${RELATED_READING_PATH}: ${path} links to ${href}, which is not a blog post or docs page; rerun node scripts/internal-links.mjs related`);
      }
    }
    out.set(path, items);
  }
  return out;
}

export function renderRelatedReading(items, escapeHtml) {
  if (!items?.length) return '';
  return `      <h2>Related reading</h2>
      <ul class="related">
${items.map((item) => `        <li><a href="${escapeHtml(item.href)}">${escapeHtml(item.title)}</a></li>`).join('\n')}
      </ul>`;
}
