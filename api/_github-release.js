const RELEASES_URL = 'https://api.github.com/repos/koala73/worldmonitor/releases/latest';

export async function fetchLatestRelease(userAgent) {
  const res = await fetch(RELEASES_URL, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'User-Agent': userAgent,
    },
  });
  if (!res.ok) return null;
  return res.json();
}
