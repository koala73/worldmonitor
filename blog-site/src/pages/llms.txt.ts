import { getCollection } from 'astro:content';

export async function GET() {
  const posts = (await getCollection('blog')).sort(
    (a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf(),
  );

  const lines = [
    '# World Monitor Blog',
    '',
    '> Analysis, practical guides, and methodology for real-time global intelligence, OSINT, geopolitics, markets, supply chains, and AI agents.',
    '',
    'Canonical blog index: https://www.worldmonitor.app/blog/',
    'RSS feed: https://www.worldmonitor.app/blog/rss.xml',
    'Author: https://www.worldmonitor.app/blog/authors/elie-habib/',
    '',
    '## Articles',
    '',
    ...posts.flatMap((post) => [
      `- [${post.data.title}](https://www.worldmonitor.app/blog/posts/${post.id}/): ${post.data.description}`,
      `  Published: ${post.data.pubDate.toISOString().slice(0, 10)}${post.data.modifiedDate ? `; updated: ${post.data.modifiedDate.toISOString().slice(0, 10)}` : ''}`,
    ]),
    '',
    '## Related machine-readable resources',
    '',
    '- [World Monitor overview](https://www.worldmonitor.app/llms.txt)',
    '- [Extended platform reference](https://www.worldmonitor.app/llms-full.txt)',
    '- [Developer and API reference](https://www.worldmonitor.app/api/llms.txt)',
    '- [Global intelligence glossary](https://www.worldmonitor.app/blog/glossary/)',
    '',
  ];

  return new Response(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
