/**
 * RPC: listTechEvents
 *
 * Aggregates tech events from three sources:
 * - Techmeme ICS calendar
 * - dev.events RSS feed
 * - Curated major conferences
 *
 * Supports filtering by type, mappability, time range, and limit.
 * Includes geocoding via 500-city coordinate lookup.
 * Returns graceful error response on failure.
 */

import type {
  ServerContext,
  ListTechEventsRequest,
  ListTechEventsResponse,
  TechEvent,
  TechEventCoords,
} from '../../../../src/generated/server/worldmonitor/research/v1/service_server';
import { CITY_COORDS } from '../../../../api/data/city-coords';
import { CHROME_UA } from '../../../_shared/constants';
import { getCachedJson, setCachedJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'research:tech-events:v1';
const REDIS_CACHE_TTL = 21600; // 6 hr — weekly event data

// ---------- Constants ----------

const ICS_URL = 'https://www.techmeme.com/newsy_events.ics';
const DEV_EVENTS_RSS = 'https://dev.events/rss.xml';

// Curated major tech events that may fall off limited RSS feeds
const CURATED_EVENTS: TechEvent[] = [
  {
    id: 'step-dubai-2026',
    title: 'STEP Dubai 2026',
    type: 'conference',
    location: 'Dubai Internet City, Dubai',
    coords: { lat: 25.0956, lng: 55.1548, country: 'UAE', original: 'Dubai Internet City, Dubai', virtual: false },
    startDate: '2026-02-11',
    endDate: '2026-02-12',
    url: 'https://dubai.stepconference.com',
    source: 'curated',
    description: 'Intelligence Everywhere: The AI Economy - 8,000+ attendees, 400+ startups',
  },
  {
    id: 'gitex-global-2026',
    title: 'GITEX Global 2026',
    type: 'conference',
    location: 'Dubai World Trade Centre, Dubai',
    coords: { lat: 25.2285, lng: 55.2867, country: 'UAE', original: 'Dubai World Trade Centre, Dubai', virtual: false },
    startDate: '2026-12-07',
    endDate: '2026-12-11',
    url: 'https://www.gitex.com',
    source: 'curated',
    description: 'World\'s largest tech & startup show',
  },
  {
    id: 'token2049-dubai-2026',
    title: 'TOKEN2049 Dubai 2026',
    type: 'conference',
    location: 'Dubai, UAE',
    coords: { lat: 25.2048, lng: 55.2708, country: 'UAE', original: 'Dubai, UAE', virtual: false },
    startDate: '2026-04-29',
    endDate: '2026-04-30',
    url: 'https://www.token2049.com',
    source: 'curated',
    description: 'Premier crypto event in Dubai',
  },
  {
    id: 'collision-2026',
    title: 'Collision 2026',
    type: 'conference',
    location: 'Toronto, Canada',
    coords: { lat: 43.6532, lng: -79.3832, country: 'Canada', original: 'Toronto, Canada', virtual: false },
    startDate: '2026-06-22',
    endDate: '2026-06-25',
    url: 'https://collisionconf.com',
    source: 'curated',
    description: 'North America\'s fastest growing tech conference',
  },
  {
    id: 'web-summit-2026',
    title: 'Web Summit 2026',
    type: 'conference',
    location: 'Lisbon, Portugal',
    coords: { lat: 38.7223, lng: -9.1393, country: 'Portugal', original: 'Lisbon, Portugal', virtual: false },
    startDate: '2026-11-02',
    endDate: '2026-11-05',
    url: 'https://websummit.com',
    source: 'curated',
    description: 'The world\'s premier tech conference',
  },
];

// ---------- Geocoding ----------

function normalizeLocation(location: string | null): (TechEventCoords) | null {
  if (!location) return null;

  // Clean up the location string
  let normalized = location.toLowerCase().trim();

  // Remove common suffixes/prefixes
  normalized = normalized.replace(/^hybrid:\s*/i, '');
  normalized = normalized.replace(/,\s*(usa|us|uk|canada)$/i, '');

  // Direct lookup
  if (CITY_COORDS[normalized]) {
    const c = CITY_COORDS[normalized];
    return { lat: c!.lat, lng: c!.lng, country: c!.country, original: location, virtual: c!.virtual ?? false };
  }

  // Try removing state/country suffix
  const parts = normalized.split(',');
  if (parts.length > 1) {
    const city = parts[0]!.trim();
    if (CITY_COORDS[city]) {
      const c = CITY_COORDS[city]!;
      return { lat: c.lat, lng: c.lng, country: c.country, original: location, virtual: c.virtual ?? false };
    }
  }

  // Try fuzzy match (contains)
  for (const [key, coords] of Object.entries(CITY_COORDS)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return { lat: coords.lat, lng: coords.lng, country: coords.country, original: location, virtual: coords.virtual ?? false };
    }
  }

  return null;
}

// ---------- ICS Parser ----------

function parseICS(icsText: string): TechEvent[] {
  const events: TechEvent[] = [];
  const eventBlocks = icsText.split('BEGIN:VEVENT').slice(1);

  for (const block of eventBlocks) {
    const summaryMatch = block.match(/SUMMARY:(.+)/);
    const locationMatch = block.match(/LOCATION:(.+)/);
    const dtstartMatch = block.match(/DTSTART;VALUE=DATE:(\d+)/);
    const dtendMatch = block.match(/DTEND;VALUE=DATE:(\d+)/);
    const urlMatch = block.match(/URL:(.+)/);
    const uidMatch = block.match(/UID:(.+)/);

    if (summaryMatch && dtstartMatch) {
      const summary = summaryMatch[1]!.trim();
      const location = locationMatch ? locationMatch[1]!.trim() : '';
      const startDate = dtstartMatch[1]!;
      const endDate = dtendMatch ? dtendMatch[1]! : startDate;
      const url = urlMatch ? urlMatch[1]!.trim() : '';
      const uid = uidMatch ? uidMatch[1]!.trim() : '';

      // Determine event type
      let type = 'other';
      if (summary.startsWith('Earnings:')) type = 'earnings';
      else if (summary.startsWith('IPO')) type = 'ipo';
      else if (location) type = 'conference';

      // Parse coordinates if location exists
      const coords = normalizeLocation(location || null);

      events.push({
        id: uid,
        title: summary,
        type,
        location: location,
        coords: coords ?? undefined,
        startDate: `${startDate.slice(0, 4)}-${startDate.slice(4, 6)}-${startDate.slice(6, 8)}`,
        endDate: `${endDate.slice(0, 4)}-${endDate.slice(4, 6)}-${endDate.slice(6, 8)}`,
        url: url,
        source: 'techmeme',
        description: '',
      });
    }
  }

  return events.sort((a, b) => a.startDate.localeCompare(b.startDate));
}

// ---------- RSS Parser ----------

function parseDevEventsRSS(rssText: string): TechEvent[] {
  const events: TechEvent[] = [];

  // Simple regex-based RSS parsing for edge runtime
  const itemMatches = rssText.matchAll(/<item>([\s\S]*?)<\/item>/g);

  for (const match of itemMatches) {
    const item = match[1]!;

    const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/);
    const linkMatch = item.match(/<link>(.*?)<\/link>/);
    const descMatch = item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>|<description>(.*?)<\/description>/s);
    const guidMatch = item.match(/<guid[^>]*>(.*?)<\/guid>/);

    const title = titleMatch ? (titleMatch[1] ?? titleMatch[2]) : null;
    const link = linkMatch ? linkMatch[1] ?? '' : '';
    const description = descMatch ? (descMatch[1] ?? descMatch[2] ?? '') : '';
    const guid = guidMatch ? guidMatch[1] ?? '' : '';

    if (!title) continue;

    // Parse date from description: "EventName is happening on Month Day, Year"
    const dateMatch = description.match(/on\s+(\w+\s+\d{1,2},?\s+\d{4})/i);
    let startDate: string | null = null;
    if (dateMatch) {
      const parsed = new Date(dateMatch[1]!);
      if (!isNaN(parsed.getTime())) {
        startDate = parsed.toISOString().split('T')[0]!;
      }
    }

    // Parse location from description: various formats
    let location: string | null = null;
    const locationMatch = description.match(/(?:in|at)\s+([A-Za-z\s]+,\s*[A-Za-z\s]+)(?:\.|$)/i) ||
                          description.match(/Location:\s*([^<\n]+)/i);
    if (locationMatch) {
      location = locationMatch[1]!.trim();
    }
    // Check for "Online" events
    if (description.toLowerCase().includes('online')) {
      location = 'Online';
    }

    // Skip events without valid dates or in the past
    if (!startDate) continue;
    const eventDate = new Date(startDate);
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    if (eventDate < now) continue;

    const coords = location && location !== 'Online' ? normalizeLocation(location) : null;

    events.push({
      id: guid || `dev-events-${title.slice(0, 20)}`,
      title: title,
      type: 'conference',
      location: location || '',
      coords: coords ?? (location === 'Online' ? { lat: 0, lng: 0, country: 'Virtual', original: 'Online', virtual: true } : undefined),
      startDate: startDate,
      endDate: startDate, // RSS doesn't have end date
      url: link,
      source: 'dev.events',
      description: '',
    });
  }

  return events;
}

// ---------- Fetch ----------

async function fetchTechEvents(req: ListTechEventsRequest): Promise<ListTechEventsResponse> {
  const { type, mappable, limit, days } = req;

  // Fetch both sources in parallel
  const [icsResponse, rssResponse] = await Promise.allSettled([
    fetch(ICS_URL, {
      headers: { 'User-Agent': CHROME_UA },
    }),
    fetch(DEV_EVENTS_RSS, {
      headers: { 'User-Agent': CHROME_UA },
    }),
  ]);

  let events: TechEvent[] = [];

  // Parse Techmeme ICS
  if (icsResponse.status === 'fulfilled' && icsResponse.value.ok) {
    const icsText = await icsResponse.value.text();
    events.push(...parseICS(icsText));
  } else {
    console.warn('Failed to fetch Techmeme ICS');
  }

  // Parse dev.events RSS
  if (rssResponse.status === 'fulfilled' && rssResponse.value.ok) {
    const rssText = await rssResponse.value.text();
    const devEvents = parseDevEventsRSS(rssText);
    events.push(...devEvents);
  } else {
    console.warn('Failed to fetch dev.events RSS');
  }

  // Add curated events (major conferences that may fall off limited RSS feeds)
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  for (const curated of CURATED_EVENTS) {
    const eventDate = new Date(curated.startDate);
    if (eventDate >= now) {
      events.push(curated);
    }
  }

  // Deduplicate by title similarity (rough match)
  const seen = new Set<string>();
  events = events.filter(e => {
    const year = e.startDate.slice(0, 4);
    const key = e.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30) + year;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by date
  events.sort((a, b) => a.startDate.localeCompare(b.startDate));

  // Filter by type if specified
  if (type && type !== 'all') {
    events = events.filter(e => e.type === type);
  }

  // Filter to only mappable events if requested
  if (mappable) {
    events = events.filter(e => e.coords && !e.coords.virtual);
  }

  // Filter by time range if specified
  if (days > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + days);
    events = events.filter(e => new Date(e.startDate) <= cutoff);
  }

  // Apply limit if specified
  if (limit > 0) {
    events = events.slice(0, limit);
  }

  // Add metadata
  const conferences = events.filter(e => e.type === 'conference');
  const mappableCount = conferences.filter(e => e.coords && !e.coords.virtual).length;

  return {
    success: true,
    count: events.length,
    conferenceCount: conferences.length,
    mappableCount,
    lastUpdated: new Date().toISOString(),
    events,
    error: '',
  };
}

function applyLimit(res: ListTechEventsResponse, limit: number): ListTechEventsResponse {
  const events = res.events.slice(0, limit);
  const conferences = events.filter(e => e.type === 'conference');
  const mappableCount = conferences.filter(e => e.coords && !e.coords.virtual).length;
  return { ...res, events, count: events.length, conferenceCount: conferences.length, mappableCount };
}

// ---------- Handler ----------

export async function listTechEvents(
  _ctx: ServerContext,
  req: ListTechEventsRequest,
): Promise<ListTechEventsResponse> {
  try {
    const cacheKey = `${REDIS_CACHE_KEY}:${req.type || 'all'}:${req.mappable ? 1 : 0}:${req.days || 0}`;
    const cached = (await getCachedJson(cacheKey)) as ListTechEventsResponse | null;
    if (cached?.events?.length) {
      if (req.limit > 0 && cached.events.length > req.limit) {
        return applyLimit(cached, req.limit);
      }
      return cached;
    }

    const result = await fetchTechEvents({ ...req, limit: 0 });
    if (result.events.length > 0) {
      setCachedJson(cacheKey, result, REDIS_CACHE_TTL).catch(() => {});
    }
    if (req.limit > 0 && result.events.length > req.limit) {
      return applyLimit(result, req.limit);
    }
    return result;
  } catch (error) {
    return {
      success: false,
      count: 0,
      conferenceCount: 0,
      mappableCount: 0,
      lastUpdated: new Date().toISOString(),
      events: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
