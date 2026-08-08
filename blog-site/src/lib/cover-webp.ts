import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Resolves the WebP siblings (full + 640w thumb) for a post cover, but ONLY
// when both files actually exist under public/ at build time. A <picture>
// <source> that 404s does NOT fall back to the <img> src — the browser
// commits to the advertised type first — so advertising a missing WebP would
// render a broken hero. Deploy-generated covers (/blog/og/*.png from
// generate-og-images.mjs) have no committed WebP siblings and must fall
// through to their original file.
//
// Anchored on cwd, not import.meta.url: Astro bundles this module into a
// build chunk whose URL no longer sits next to src/, which silently broke
// the existence checks. astro runs from blog-site/, the repo test suite from
// the repo root — probe both.
const PUBLIC_DIR = [
  resolve(process.cwd(), 'public'),
  resolve(process.cwd(), 'blog-site/public'),
].find((dir) => existsSync(resolve(dir, 'images/blog'))) ?? resolve(process.cwd(), 'public');
const SITE_BASE = '/blog/';

const swapExt = (src: string, suffix: string) => src.replace(/\.(jpe?g|png)$/i, suffix);

const localPublicPath = (src: string): string | null => {
  if (!src.startsWith(SITE_BASE)) return null;
  return resolve(PUBLIC_DIR, src.slice(SITE_BASE.length));
};

export interface CoverWebpSources {
  webp: string;
  webp640: string;
}

export const coverWebpSources = (src: string | undefined): CoverWebpSources | null => {
  if (!src) return null;
  const webp = swapExt(src, '.webp');
  if (webp === src) return null;
  const webp640 = swapExt(src, '-640.webp');
  const localWebp = localPublicPath(webp);
  const localWebp640 = localPublicPath(webp640);
  if (!localWebp || !localWebp640) return null;
  if (!existsSync(localWebp) || !existsSync(localWebp640)) return null;
  return { webp, webp640 };
};
