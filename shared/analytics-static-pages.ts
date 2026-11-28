import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

interface AnalyticsEnv {
  VITE_ANALYTICS_ENABLED?: string;
}

const UMAMI_SCRIPT_TAG_RE = /[ \t]*<script\b[^>]*\bsrc="https:\/\/abacus\.worldmonitor\.app\/script\.js"[^>]*><\/script>[ \t]*\r?\n?/g;

/**
 * Same rule as src/services/analytics.ts: only the literal 'false' turns
 * Umami off, so an unset or empty build arg keeps the hosted behaviour.
 */
export function isAnalyticsBuildEnabled(env: AnalyticsEnv): boolean {
  return env.VITE_ANALYTICS_ENABLED !== 'false';
}

/**
 * Remove every hardcoded Umami <script> tag from a static HTML document.
 *
 * Args:
 *   html: the document text.
 * Returns:
 *   the document without the tags and the lines they sat on.
 */
export function stripUmamiScriptTags(html: string): string {
  return html.replace(UMAMI_SCRIPT_TAG_RE, '');
}

/**
 * Strip the Umami tag from every .html file under `dir`, which covers the
 * public/ pages Vite copies verbatim (the /agent page, the crawlable corpus,
 * the /pro build). A missing directory changes nothing.
 *
 * Args:
 *   dir: the build output directory.
 * Returns:
 *   the rewritten paths relative to `dir`.
 */
export async function stripUmamiScriptTagsInDir(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const pages = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => join(entry.parentPath, entry.name));
  const rewritten: string[] = [];
  await Promise.all(pages.map(async (path) => {
    const html = await readFile(path, 'utf8');
    const stripped = stripUmamiScriptTags(html);
    if (stripped === html) return;
    await writeFile(path, stripped);
    rewritten.push(relative(dir, path));
  }));
  return rewritten.sort();
}
