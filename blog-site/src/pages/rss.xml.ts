import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ESCAPE_XML_RE = /&/g;
const ESCAPE_XML_RE_2 = /</g;
const ESCAPE_XML_RE_3 = />/g;
const ESCAPE_XML_RE_4 = /"/g;
const GET_PUBLIC_ASSET_PATH_RE = /^https?:\/\//;
const WITHOUT_BLOG_BASE_RE = /^\//;


const PUBLIC_DIR = join(process.cwd(), 'public');
const DEFAULT_AUTHOR = 'Elie Habib';

function escapeXml(value: string): string {
  return value
    .replace(ESCAPE_XML_RE, '&amp;')
    .replace(ESCAPE_XML_RE_2, '&lt;')
    .replace(ESCAPE_XML_RE_3, '&gt;')
    .replace(ESCAPE_XML_RE_4, '&quot;');
}

function getPublicAssetPath(pathOrUrl: string | undefined): string | undefined {
  if (!pathOrUrl || GET_PUBLIC_ASSET_PATH_RE.test(pathOrUrl)) return undefined;
  const withoutBlogBase = pathOrUrl.startsWith('/blog/')
    ? pathOrUrl.slice('/blog/'.length)
    : pathOrUrl.replace(WITHOUT_BLOG_BASE_RE, '');
  return join(PUBLIC_DIR, withoutBlogBase);
}

function getEnclosure(heroImage: string | undefined) {
  if (!heroImage) return undefined;
  const url = GET_PUBLIC_ASSET_PATH_RE.test(heroImage)
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
