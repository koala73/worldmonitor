import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';

export async function GET(context: { site: URL }) {
  const posts = await getCollection('blog');
  return rss({
    title: 'World Monitor Blog',
    description: 'Real-time global intelligence, OSINT, geopolitics, and markets.',
    site: context.site,
    xmlns: {
      atom: 'http://www.w3.org/2005/Atom',
    },
    customData: [
      '<language>en-us</language>',
      `<atom:link href="https://www.worldmonitor.app/blog/rss.xml" rel="self" type="application/rss+xml" />`,
    ].join(''),
    items: posts
      .sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf())
      .map((post) => ({
        title: post.data.title,
        pubDate: post.data.pubDate,
        description: post.data.description,
        link: `/blog/posts/${post.id}/`,
        categories: post.data.keywords?.split(',').map((k: string) => k.trim()),
        ...(post.data.heroImage ? {
          enclosure: {
            url: `https://www.worldmonitor.app${post.data.heroImage}`,
            length: 0,
            type: 'image/jpeg',
          },
        } : {}),
      })),
  });
}
