const REDDIT_HOSTS = new Set(['reddit.com', 'www.reddit.com', 'old.reddit.com']);

function finiteNumber(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : 0;
}

export function normalizeSocialVelocity(data) {
  if (!data || typeof data !== 'object' || !('posts' in data) || !Array.isArray(data.posts)) {
    return { posts: [], fetchedAt: 0 };
  }
  const posts = [];
  for (const post of data.posts) {
    if (!post || typeof post !== 'object' || Array.isArray(post)) continue;
    const p = post;
    if (typeof p.url !== 'string' || p.url.length > 2048) continue;
    let url;
    try { url = new URL(p.url); } catch { continue; }
    if (!['https:', 'http:'].includes(url.protocol) || !REDDIT_HOSTS.has(url.hostname)
      || url.username || url.password || url.port
      || !/^\/r\/[A-Za-z0-9_]+\/comments\/[A-Za-z0-9]+(?:\/|$)/.test(url.pathname)) continue;
    posts.push({
      id: typeof p.id === 'string' ? p.id.slice(0, 128) : '',
      title: typeof p.title === 'string' ? p.title.slice(0, 300) : '',
      subreddit: typeof p.subreddit === 'string' ? p.subreddit.slice(0, 64) : '',
      url: url.href,
      score: Math.trunc(finiteNumber(p.score, -2147483648, 2147483647)),
      upvoteRatio: finiteNumber(p.upvoteRatio, 0, 1),
      numComments: Math.trunc(finiteNumber(p.numComments, 0, 2147483647)),
      velocityScore: finiteNumber(p.velocityScore, 0, Number.MAX_SAFE_INTEGER),
      createdAt: Math.trunc(finiteNumber(p.createdAt, 0, Number.MAX_SAFE_INTEGER)),
    });
    if (posts.length === 30) break;
  }
  if (data.posts.length > 0 && posts.length === 0) return { posts: [], fetchedAt: 0 };
  return { posts, fetchedAt: Math.trunc(finiteNumber('fetchedAt' in data ? data.fetchedAt : 0, 0, Number.MAX_SAFE_INTEGER)) };
}
