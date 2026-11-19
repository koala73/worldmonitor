// Fenced renewal of one cached RSS feed parse after a 304.
//
// A background refresh reads the feed entry, asks upstream, and on 304
// rewrites the entry it read with a new fetchedAt. If the entry expired while
// the request was in flight, a foreground fetch may have stored a newer parse
// and its country pool (rss:feed-country:v1) by then. A blind rewrite would
// put the older entry back, and readers would drop the newer pool because its
// parsedAt no longer matches. This script renews the entry only while Redis
// still holds the parse the refresh read.
//
// KEYS[1] is the feed key (rss:feed:v11:<variant>:<url>).
// ARGV: 1=parsedAt of the entry the refresh read, 2=renewed entry JSON,
// 3=absolute expiry in Unix milliseconds. An absolute expiry, unlike a TTL,
// cannot be pushed past the country pool by a write that lands late (one the
// client already gave up on, for example). A deadline already passed deletes
// the entry, so the next build fetches the feed again.
// Returns 1 when renewed, 0 when the key is gone or holds another parse.
//
// docker/redis-rest-proxy.mjs carries a byte-identical pinned copy because it
// allowlists EVAL scripts by exact text. Keep the two copies in sync.
export const RSS_FEED_RENEW_SCRIPT = [
  "local current = redis.call('GET', KEYS[1])",
  'if not current then return 0 end',
  'local ok, entry = pcall(cjson.decode, current)',
  "if not ok or type(entry) ~= 'table' or entry.parsedAt ~= tonumber(ARGV[1]) then return 0 end",
  "redis.call('SET', KEYS[1], ARGV[2], 'PXAT', ARGV[3])",
  'return 1',
].join('\n');
