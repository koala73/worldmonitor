import type {
    ServerContext,
    ListAviationNewsRequest,
    ListAviationNewsResponse,
    AviationNewsItem,
} from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { ApiError } from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { cachedFetchJson } from '../../../_shared/redis';
import { CHROME_UA } from '../../../_shared/constants';
import { parseStringArray, xmlParser } from './_shared';
import { incrementProviderCounter } from './_counters';

const CACHE_TTL = 900; // 15 minutes

const AVIATION_RSS_FEEDS = [
    { url: 'https://www.flightglobal.com/rss', name: 'FlightGlobal' },
    { url: 'https://simpleflying.com/feed/', name: 'Simple Flying' },
    { url: 'https://aerotime.aero/feed', name: 'AeroTime' },
    { url: 'https://thepointsguy.com/feed/', name: 'The Points Guy' },
    { url: 'https://airlinegeeks.com/feed/', name: 'Airline Geeks' },
    { url: 'https://onemileatatime.com/feed/', name: 'One Mile at a Time' },
    { url: 'https://viewfromthewing.com/feed/', name: 'View from the Wing' },
    { url: 'https://www.aviationpros.com/rss', name: 'Aviation Pros' },
    { url: 'https://www.aviationweek.com/rss', name: 'Aviation Week' },
];

interface RssItem {
    title?: string;
    link?: string;
    pubDate?: string;
    description?: string;
    _source: string;
}

function parseRssItems(xml: string, sourceName: string): RssItem[] {
    try {
        const parsed = xmlParser.parse(xml);
        const channel = parsed?.rss?.channel ?? parsed?.feed ?? {};
        const rawItems: unknown[] = Array.isArray(channel.item) ? channel.item
            : channel.item ? [channel.item]
                : Array.isArray(channel.entry) ? channel.entry
                    : channel.entry ? [channel.entry] : [];

        // Bound matching text and serialized records: 270 x 3KiB stays below the local cache limit.
        return rawItems.slice(0, 30).map((item: any) => ({
            title: String(item?.title ?? '').trim().slice(0, 512),
            link: typeof (item?.link ?? item?.guid) === 'string' ? (item.link ?? item.guid).trim() : '',
            pubDate: String(item?.pubDate ?? item?.published ?? item?.updated ?? '').trim().slice(0, 128),
            description: String(item?.description ?? item?.summary ?? item?.content ?? '').trim().slice(0, 2048),
            _source: sourceName,
        })).filter(item => item.link.length > 0 && item.link.length <= 2048 && new TextEncoder().encode(JSON.stringify(item)).byteLength <= 3072);
    } catch {
        return [];
    }
}

function matchesEntities(text: string, entities: string[]): string[] {
    if (!entities.length) return [];
    const lower = text.toLowerCase();
    return entities.filter(e => lower.includes(e.toLowerCase()));
}

async function fetchFeed(feedUrl: string, sourceName: string): Promise<RssItem[]> {
    try {
        const resp = await fetch(feedUrl, {
            headers: {
                'User-Agent': CHROME_UA,
                'Accept': 'application/rss+xml, application/xml, text/xml, */*',
            },
            signal: AbortSignal.timeout(8_000),
        });
        if (resp.status === 401 || resp.status === 403) {
            incrementProviderCounter('aviationNewsAuthRejection');
            return [];
        }
        if (!resp.ok) {
            incrementProviderCounter('aviationNewsTerminalFailure');
            return [];
        }
        const xml = await resp.text();
        incrementProviderCounter('aviationNewsSuccess');
        return parseRssItems(xml, sourceName);
    } catch (err) {
        const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.message.includes('timed out'));
        if (isTimeout) incrementProviderCounter('aviationNewsTimeout');
        else incrementProviderCounter('aviationNewsTerminalFailure');
        return [];
    }
}

export async function listAviationNews(
    _ctx: ServerContext,
    req: ListAviationNewsRequest,
): Promise<ListAviationNewsResponse> {
    const inputEntities = parseStringArray(req.entities);
    // Ten matches the RPC array contract; 128 leaves room for free-form airline
    // names and routes without admitting unbounded matching work.
    if (inputEntities.length > 10 || inputEntities.some(entity => entity.length > 128)) {
        throw new ApiError(400, 'Expected at most 10 entities of at most 128 characters each', '');
    }
    const entities = inputEntities.map(entity => entity.toUpperCase());
    const windowHours = req.windowHours ?? 24;
    const windowMs = windowHours * 60 * 60 * 1000;
    const maxItems = Math.min(req.maxItems ?? 20, 50);
    const now = Date.now();

    try {
        // All requests fetch the same nine feeds. Cache their bounded snapshot,
        // then apply request-specific filters without creating more Redis keys.
        const snapshot = await cachedFetchJson<{ items: RssItem[] }>(
            'aviation:news:feeds:v2', CACHE_TTL, async () => {
                const allItems: RssItem[] = [];
                await Promise.allSettled(
                    AVIATION_RSS_FEEDS.map(feed => fetchFeed(feed.url, feed.name).then(items => allItems.push(...items)))
                );
                return { items: allItems };
            }
        );
        const allItems = snapshot?.items ?? [];

        const cutoff = now - windowMs;
        const filtered: AviationNewsItem[] = [];

        for (const item of allItems) {
            const title = item.title ?? '';
            const link = item.link ?? '';
            if (!title || typeof link !== 'string' || !link) continue;

            let publishedAt = 0;
            if (item.pubDate) {
                try { publishedAt = new Date(item.pubDate as string).getTime(); } catch { /* skip */ }
            }
            if (publishedAt && publishedAt < cutoff) continue;

            const textToSearch = `${title} ${item.description ?? ''}`;
            const matched = matchesEntities(textToSearch, entities);
            if (entities.length > 0 && matched.length === 0) continue;

            let snippet = '';
            let insideTag = false;
            const description = item.description ?? '';
            for (let i = 0; i < description.length && snippet.length < 200; i++) {
                const character = description[i]!;
                if (character === '<') insideTag = true;
                else if (insideTag) {
                    if (character === '>') insideTag = false;
                } else snippet += character;
            }

            filtered.push({
                id: btoa(String.fromCharCode(...new TextEncoder().encode(link))).slice(0, 32),
                title,
                url: link,
                sourceName: (item._source as string) ?? 'Aviation News',
                publishedAt: publishedAt || now,
                snippet,
                matchedEntities: matched,
                imageUrl: '',
            });
        }

        // Sort by newest first
        filtered.sort((a, b) => b.publishedAt - a.publishedAt);

        return {
            items: filtered.slice(0, maxItems),
            source: 'rss',
            updatedAt: now,
        };
    } catch (err) {
        console.warn(`[Aviation] ListAviationNews failed: ${err instanceof Error ? err.message : err}`);
        return { items: [], source: 'error', updatedAt: now };
    }
}
