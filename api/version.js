export const config = { runtime: 'edge' };

const RELEASES_URL = 'https://api.github.com/repos/koala73/worldmonitor/releases/latest';

export default async function handler() {
  try {
    const res = await fetch(RELEASES_URL, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'WorldMonitor-Version-Check',
      },
    });

    if (!res.ok) {
      return new Response(JSON.stringify({ error: 'upstream' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const release = await res.json();
    const tag = release.tag_name ?? '';
    const version = tag.replace(/^v/, '');

    return new Response(JSON.stringify({
      version,
      tag,
      url: release.html_url,
      prerelease: release.prerelease ?? false,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch {
    return new Response(JSON.stringify({ error: 'fetch_failed' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
