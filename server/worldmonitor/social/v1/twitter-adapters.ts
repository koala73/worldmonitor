/**
 * Twitter/X data source adapter pattern.
 *
 * Interface: TwitterDataSource — swappable adapter implementations.
 * Default: TwitterApiIoAdapter (~$0.15/1K tweets)
 * Fallbacks: SocialDataAdapter, OfficialXApiAdapter ($200/mo)
 *
 * Adapter selected via available credentials (factory pattern).
 */

export interface TwitterRawTweet {
  id: string;
  text: string;
  author: string;
  createdAt: string;
  likeCount: number;
  retweetCount: number;
  url: string;
}

export interface TwitterDataSource {
  searchTweets(query: string, limit: number): Promise<TwitterRawTweet[]>;
  getUserTweets(username: string, limit: number): Promise<TwitterRawTweet[]>;
  readonly name: string;
}

/** Default adapter: TwitterAPI.io -- $0.15/1K tweets */
export class TwitterApiIoAdapter implements TwitterDataSource {
  readonly name = 'twitterapi.io';
  private apiKey: string;
  constructor(apiKey: string) { this.apiKey = apiKey; }

  async searchTweets(query: string, limit: number): Promise<TwitterRawTweet[]> {
    const url = `https://api.twitterapi.io/twitter/tweet/advanced_search?query=${encodeURIComponent(query)}&queryType=Latest&cursor=`;
    const res = await fetch(url, {
      headers: { 'X-API-Key': this.apiKey },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = await res.json() as any;
    return (data.tweets ?? []).slice(0, limit).map((t: any): TwitterRawTweet => ({
      id: t.id,
      text: t.text ?? '',
      author: t.author?.userName ?? '',
      createdAt: t.createdAt ?? '',
      likeCount: t.likeCount ?? 0,
      retweetCount: t.retweetCount ?? 0,
      url: `https://x.com/i/status/${t.id}`,
    }));
  }

  async getUserTweets(username: string, limit: number): Promise<TwitterRawTweet[]> {
    return this.searchTweets(`from:${username}`, limit);
  }
}

/** Fallback: SocialData API */
export class SocialDataAdapter implements TwitterDataSource {
  readonly name = 'socialdata';
  private apiKey: string;
  constructor(apiKey: string) { this.apiKey = apiKey; }

  async searchTweets(query: string, limit: number): Promise<TwitterRawTweet[]> {
    const url = `https://api.socialdata.tools/twitter/search?query=${encodeURIComponent(query)}&type=Latest`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = await res.json() as any;
    return (data.tweets ?? []).slice(0, limit).map((t: any): TwitterRawTweet => ({
      id: t.id_str ?? t.id,
      text: t.full_text ?? t.text ?? '',
      author: t.user?.screen_name ?? '',
      createdAt: t.tweet_created_at ?? '',
      likeCount: t.favorite_count ?? 0,
      retweetCount: t.retweet_count ?? 0,
      url: `https://x.com/i/status/${t.id_str ?? t.id}`,
    }));
  }

  async getUserTweets(username: string, limit: number): Promise<TwitterRawTweet[]> {
    return this.searchTweets(`from:${username}`, limit);
  }
}

/** Official X API (requires $200/mo Basic tier) */
export class OfficialXApiAdapter implements TwitterDataSource {
  readonly name = 'official-x';
  private bearerToken: string;
  constructor(bearerToken: string) { this.bearerToken = bearerToken; }

  async searchTweets(query: string, limit: number): Promise<TwitterRawTweet[]> {
    const url = `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=${Math.min(limit, 100)}&tweet.fields=created_at,public_metrics,author_id`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${this.bearerToken}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = await res.json() as any;
    return (data.data ?? []).map((t: any): TwitterRawTweet => ({
      id: t.id,
      text: t.text ?? '',
      author: t.author_id ?? '',
      createdAt: t.created_at ?? '',
      likeCount: t.public_metrics?.like_count ?? 0,
      retweetCount: t.public_metrics?.retweet_count ?? 0,
      url: `https://x.com/i/status/${t.id}`,
    }));
  }

  async getUserTweets(username: string, limit: number): Promise<TwitterRawTweet[]> {
    return this.searchTweets(`from:${username}`, limit);
  }
}

/** Factory: select adapter based on available credentials */
export function createTwitterAdapter(): TwitterDataSource | null {
  const twitterApiIoKey = process.env.TWITTER_API_IO_KEY;
  if (twitterApiIoKey) return new TwitterApiIoAdapter(twitterApiIoKey);

  const socialDataKey = process.env.SOCIALDATA_API_KEY;
  if (socialDataKey) return new SocialDataAdapter(socialDataKey);

  const bearerToken = process.env.TWITTER_BEARER_TOKEN;
  if (bearerToken) return new OfficialXApiAdapter(bearerToken);

  return null;
}
