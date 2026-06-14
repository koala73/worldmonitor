import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PUBLIC_DIR = join(process.cwd(), 'public');
const DEFAULT_AUTHOR = 'Elie Habib';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getPublicAssetPath(pathOrUrl: string | undefined): string | undefined {
  if (!pathOrUrl || /^https?:\/\//.test(pathOrUrl)) return undefined;
  const withoutBlogBase = pathOrUrl.startsWith('/blog/')
    ? pathOrUrl.slice('/blog/'.length)
    : pathOrUrl.replace(/^\//, '');
  return join(PUBLIC_DIR, withoutBlogBase);
}

function getEnclosure(heroImage: string | undefined) {
  if (!heroImage) return undefined;
  const url = /^https?:\/\//.test(heroImage)
    ? heroImage
    : `https://www.worldmonitor.app${heroImage}`;
  const localPath = getPublicAssetPath(heroImage);
  const length = localPath && existsSync(localPath) ? statSync(localPath).size : 1;
  return {
    url,
    length,
    type: heroImage.endsWith('.png') ? 'image/png' : 'image/jpeg',
  };
}

export async function GET(context: { site: URL }) {
  const posts = await getCollection('blog');
  return rss({
    title: 'World Monitor Blog',
    description: 'Real-time global intelligence, OSINT, geopolitics, and markets.',
    site: context.site,
    xmlns: {
      atom: 'http://www.w3.org/2005/Atom',
      dc: 'http://purl.org/dc/elements/1.1/',
      media: 'http://search.yahoo.com/mrss/',
    },
    customData: [
      '<language>en-us</language>',
      `<atom:link href="https://www.worldmonitor.app/blog/rss.xml" rel="self" type="application/rss+xml" />`,
    ].join(''),
    items: posts
      .sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf())
      .map((post) => {
        const enclosure = getEnclosure(post.data.heroImage);
        return {
          title: post.data.title,
          pubDate: post.data.pubDate,
          description: post.data.description,
          link: `/blog/posts/${post.id}/`,
          categories: post.data.keywords?.split(',').map((k: string) => k.trim()),
          ...(enclosure ? { enclosure } : {}),
          customData: [
            `<dc:creator>${escapeXml(post.data.author || DEFAULT_AUTHOR)}</dc:creator>`,
            post.data.modifiedDate ? `<atom:updated>${post.data.modifiedDate.toISOString()}</atom:updated>` : '',
            enclosure ? `<media:content url="${escapeXml(enclosure.url)}" medium="image" type="${enclosure.type}" />` : '',
          ].filter(Boolean).join(''),
        };
      }),
  });
}
