// Non-sebuf: returns XML/HTML, stays as standalone Vercel function
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
export const config = { runtime: 'edge' };

// Scrape FwdStart newsletter archive and return as RSS
export default async function handler(req) {
  const cors = getCorsHeaders(req);
  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), { status: 403, headers: cors });
  }
  try {
    const response = await fetch('https://www.fwdstart.me/archive', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    const items = [];
    const seenUrls = new Set();

    // Split by embla__slide to get each post block
    const slideBlocks = html.split('embla__slide');

    for (const block of slideBlocks) {
      // Extract URL
      const urlMatch = block.match(/href="(\/p\/[^"]+)"/);
      if (!urlMatch) continue;

      const url = `https://www.fwdstart.me${urlMatch[1]}`;
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);

      // Extract title from alt attribute
      const altMatch = block.match(/alt="([^"]+)"/);
      const title = altMatch ? altMatch[1] : '';
      if (!title || title.length < 5) continue;

      // Extract date - look for "Mon DD, YYYY" pattern
      const dateMatch = block.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(\d{4})/i);
      let pubDate = new Date();
      if (dateMatch) {
        const dateStr = `${dateMatch[1]} ${dateMatch[2]}, ${dateMatch[3]}`;
        const parsed = new Date(dateStr);
        if (!isNaN(parsed.getTime())) {
          pubDate = parsed;
        }
      }

      // Extract subtitle/description if available
      let description = '';
      const subtitleMatch = block.match(/line-clamp-3[^>]*>.*?<span[^>]*>([^<]{20,})<\/span>/s);
      if (subtitleMatch) {
        description = subtitleMatch[1].trim();
      }

      items.push({ title, link: url, date: pubDate.toISOString(), description });
    }

    // Build RSS XML
    const rssItems = items.slice(0, 30).map(item => `
    <item>
      <title><![CDATA[${item.title}]]></title>
      <link>${item.link}</link>
      <guid>${item.link}</guid>
      <pubDate>${new Date(item.date).toUTCString()}</pubDate>
      <description><![CDATA[${item.description}]]></description>
      <source url="https://www.fwdstart.me">FwdStart Newsletter</source>
    </item>`).join('');

    const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>FwdStart Newsletter</title>
    <link>https://www.fwdstart.me</link>
    <description>Forward-thinking startup and VC news from MENA and beyond</description>
    <language>en-us</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="https://worldmonitor.app/api/fwdstart" rel="self" type="application/rss+xml"/>
    ${rssItems}
  </channel>
</rss>`;

    return new Response(rss, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        ...cors,
        'Cache-Control': 'public, max-age=1800, s-maxage=1800, stale-while-revalidate=300',
      },
    });
  } catch (error) {
    console.error('FwdStart scraper error:', error);
    return new Response(JSON.stringify({
      error: 'Failed to fetch FwdStart archive',
      details: error.message
    }), {
      status: 502,
      headers: {
        'Content-Type': 'application/json',
        ...cors,
      },
    });
  }
}
