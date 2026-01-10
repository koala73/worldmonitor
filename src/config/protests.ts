import type { Feed } from '@/types';

export interface ProtestLocation {
  id: string;
  city?: string;
  country: string;
  lat: number;
  lon: number;
  keywords: string[];
  relatedHotspots?: string[];
}

export const PROTEST_FEEDS: Feed[] = [
  { name: 'Reuters Protest', url: '/rss/googlenews/rss/search?q=site:reuters.com+protest+OR+demonstration+OR+strike&hl=en-US&gl=US&ceid=US:en' },
  { name: 'AP Protest', url: '/rss/googlenews/rss/search?q=site:apnews.com+protest+OR+demonstration+OR+strike&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Al Jazeera Protest', url: '/rss/googlenews/rss/search?q=site:aljazeera.com+protest+OR+demonstration+OR+strike&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Guardian Protest', url: '/rss/googlenews/rss/search?q=site:theguardian.com+protest+OR+demonstration+OR+strike&hl=en-US&gl=US&ceid=US:en' },
  { name: 'BBC Protest', url: '/rss/googlenews/rss/search?q=site:bbc.com+protest+OR+demonstration+OR+strike&hl=en-US&gl=US&ceid=US:en' },
];

export const PROTEST_LOCATIONS: ProtestLocation[] = [
  {
    id: 'paris',
    city: 'Paris',
    country: 'France',
    lat: 48.8566,
    lon: 2.3522,
    keywords: ['paris', 'france', 'french'],
    relatedHotspots: ['brussels', 'london'],
  },
  {
    id: 'buenos-aires',
    city: 'Buenos Aires',
    country: 'Argentina',
    lat: -34.6037,
    lon: -58.3816,
    keywords: ['buenos aires', 'argentina', 'argentine'],
    relatedHotspots: ['caracas'],
  },
  {
    id: 'nairobi',
    city: 'Nairobi',
    country: 'Kenya',
    lat: -1.2864,
    lon: 36.8172,
    keywords: ['nairobi', 'kenya', 'kenyan'],
    relatedHotspots: ['cairo'],
  },
  {
    id: 'manila',
    city: 'Manila',
    country: 'Philippines',
    lat: 14.5995,
    lon: 120.9842,
    keywords: ['manila', 'philippines', 'filipino'],
    relatedHotspots: ['taipei', 'beijing'],
  },
  {
    id: 'jakarta',
    city: 'Jakarta',
    country: 'Indonesia',
    lat: -6.2088,
    lon: 106.8456,
    keywords: ['jakarta', 'indonesia', 'indonesian'],
    relatedHotspots: ['beijing'],
  },
  {
    id: 'lagos',
    city: 'Lagos',
    country: 'Nigeria',
    lat: 6.5244,
    lon: 3.3792,
    keywords: ['lagos', 'nigeria', 'nigerian'],
    relatedHotspots: ['cairo'],
  },
  {
    id: 'kyiv',
    city: 'Kyiv',
    country: 'Ukraine',
    lat: 50.4501,
    lon: 30.5234,
    keywords: ['kyiv', 'kiev', 'ukraine', 'ukrainian'],
    relatedHotspots: ['kyiv'],
  },
  {
    id: 'tehran',
    city: 'Tehran',
    country: 'Iran',
    lat: 35.6892,
    lon: 51.389,
    keywords: ['tehran', 'iran', 'iranian'],
    relatedHotspots: ['tehran'],
  },
  {
    id: 'caracas',
    city: 'Caracas',
    country: 'Venezuela',
    lat: 10.4806,
    lon: -66.9036,
    keywords: ['caracas', 'venezuela', 'venezuelan'],
    relatedHotspots: ['caracas'],
  },
];
