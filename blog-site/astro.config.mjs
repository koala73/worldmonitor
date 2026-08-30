// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_URL = 'https://www.worldmonitor.app';
const BLOG_DIR = new URL('./src/content/blog/', import.meta.url);
const GLOSSARY_DATA = new URL('./src/data/glossary.ts', import.meta.url);
const AUTHORS_DIR = new URL('./src/pages/authors/', import.meta.url);
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function readFrontmatterDate(markdown, key) {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) return undefined;

  const match = frontmatter[1].match(new RegExp(`^${key}:\\s*["']?([^"'\\n]+)["']?\\s*$`, 'm'));
  return match?.[1];
}

function setPostDate(postDates, pathname, date) {
  const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
  postDates.set(normalized, date);
  postDates.set(normalized.slice(0, -1), date);
  postDates.set(`${SITE_URL}${normalized}`, date);
  postDates.set(`${SITE_URL}${normalized.slice(0, -1)}`, date);
}

/** Prefer git commit date (YYYY-MM-DD); fall back to null when unavailable. */
function gitFileLastmod(absoluteFileUrl) {
  try {
    const absolutePath = fileURLToPath(absoluteFileUrl);
    if (!existsSync(absolutePath)) return null;
    const relative = absolutePath.startsWith(REPO_ROOT)
      ? absolutePath.slice(REPO_ROOT.length).replace(/^\//, '')
      : absolutePath;
    const out = execFileSync(
      'git',
      ['log', '-1', '--format=%cs', '--', relative],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    ).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

function laterDate(...values) {
  return values
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value ?? ''))
    .sort()
    .at(-1) ?? null;
}

function glossarySlugsFromSource(source) {
  const slugs = [];
  for (const match of source.matchAll(/slug:\s*'([^']+)'/g)) {
    slugs.push(match[1]);
  }
  return slugs;
}

export function buildPostDateMap() {
  const postDates = new Map();
  let blogLastmod = '2026-06-10';

  for (const file of readdirSync(BLOG_DIR)) {
    if (!file.endsWith('.md')) continue;

    const slug = basename(file, '.md');
    const markdown = readFileSync(new URL(file, BLOG_DIR), 'utf8');
    const date = readFrontmatterDate(markdown, 'modifiedDate')
      || readFrontmatterDate(markdown, 'pubDate');

    if (!date) continue;

    setPostDate(postDates, `/blog/posts/${slug}/`, date);
    if (date > blogLastmod) blogLastmod = date;
  }

  // Glossary + author hubs previously shipped without lastmod (#7382). Use
  // git material dates so Astro's sitemap serialize can stamp every blog URL.
  const glossaryLastmod = gitFileLastmod(GLOSSARY_DATA) || blogLastmod;
  setPostDate(postDates, '/blog/glossary/', glossaryLastmod);
  const glossarySource = readFileSync(GLOSSARY_DATA, 'utf8');
  for (const slug of glossarySlugsFromSource(glossarySource)) {
    setPostDate(postDates, `/blog/glossary/${slug}/`, glossaryLastmod);
  }

  if (existsSync(fileURLToPath(AUTHORS_DIR))) {
    for (const file of readdirSync(AUTHORS_DIR)) {
      if (!file.endsWith('.astro')) continue;
      const slug = basename(file, '.astro');
      const authorLastmod = laterDate(
        gitFileLastmod(new URL(file, AUTHORS_DIR)),
        blogLastmod,
      );
      setPostDate(postDates, `/blog/authors/${slug}/`, authorLastmod);
    }
  }

  setPostDate(postDates, '/blog/', laterDate(blogLastmod, glossaryLastmod));
  return postDates;
}

export const POST_DATES = buildPostDateMap();

export default defineConfig({
  site: 'https://www.worldmonitor.app',
  base: '/blog',
  output: 'static',
  integrations: [
    sitemap({
      serialize(item) {
        const lastmod = POST_DATES.get(item.url);
        if (lastmod) return { ...item, lastmod };
        return item;
      },
    }),
  ],
  markdown: {
    shikiConfig: {
      theme: 'github-dark',
    },
  },
});
