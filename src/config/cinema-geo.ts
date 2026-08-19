// Cinema / entertainment map data for the `cinema` variant.
// Static, bundled data so the "Cinema Hubs" layer renders with no backend —
// major film festivals, studio hubs, and industry centres worldwide,
// India-weighted. Coordinates are approximate city centres.

export type CinemaHubKind = 'festival' | 'studio' | 'hub';

export interface CinemaHub {
  id: string;
  name: string;
  lat: number;
  lon: number;
  kind: CinemaHubKind;
  city: string;
  country: string;
}

export const CINEMA_HUBS: CinemaHub[] = [
  { id: 'bollywood', name: 'Bollywood (Hindi cinema)', lat: 19.14, lon: 72.83, kind: 'hub', city: 'Mumbai', country: 'India' },
  { id: 'film-city-mumbai', name: 'Film City', lat: 19.16, lon: 72.90, kind: 'studio', city: 'Mumbai', country: 'India' },
  { id: 'tollywood', name: 'Tollywood (Telugu cinema)', lat: 17.42, lon: 78.41, kind: 'hub', city: 'Hyderabad', country: 'India' },
  { id: 'ramoji', name: 'Ramoji Film City', lat: 17.25, lon: 78.68, kind: 'studio', city: 'Hyderabad', country: 'India' },
  { id: 'kollywood', name: 'Kollywood (Tamil cinema)', lat: 13.05, lon: 80.22, kind: 'hub', city: 'Chennai', country: 'India' },
  { id: 'sandalwood', name: 'Sandalwood (Kannada cinema)', lat: 12.97, lon: 77.59, kind: 'hub', city: 'Bengaluru', country: 'India' },
  { id: 'mollywood', name: 'Mollywood (Malayalam cinema)', lat: 10.00, lon: 76.30, kind: 'hub', city: 'Kochi', country: 'India' },
  { id: 'iffi-goa', name: 'IFFI (Intl. Film Festival of India)', lat: 15.50, lon: 73.83, kind: 'festival', city: 'Goa', country: 'India' },
  { id: 'mami-mumbai', name: 'MAMI Mumbai Film Festival', lat: 19.08, lon: 72.88, kind: 'festival', city: 'Mumbai', country: 'India' },
  { id: 'cannes', name: 'Cannes Film Festival', lat: 43.55, lon: 7.02, kind: 'festival', city: 'Cannes', country: 'France' },
  { id: 'venice', name: 'Venice Film Festival', lat: 45.43, lon: 12.36, kind: 'festival', city: 'Venice', country: 'Italy' },
  { id: 'berlinale', name: 'Berlinale', lat: 52.51, lon: 13.38, kind: 'festival', city: 'Berlin', country: 'Germany' },
  { id: 'tiff', name: 'Toronto Intl. Film Festival', lat: 43.65, lon: -79.38, kind: 'festival', city: 'Toronto', country: 'Canada' },
  { id: 'sundance', name: 'Sundance Film Festival', lat: 40.65, lon: -111.50, kind: 'festival', city: 'Park City', country: 'USA' },
  { id: 'busan', name: 'Busan Intl. Film Festival', lat: 35.17, lon: 129.13, kind: 'festival', city: 'Busan', country: 'South Korea' },
  { id: 'hollywood', name: 'Hollywood', lat: 34.09, lon: -118.33, kind: 'hub', city: 'Los Angeles', country: 'USA' },
  { id: 'burbank', name: 'Studio District (Warner/Disney/Universal)', lat: 34.15, lon: -118.34, kind: 'studio', city: 'Burbank', country: 'USA' },
  { id: 'pinewood', name: 'Pinewood Studios', lat: 51.55, lon: -0.54, kind: 'studio', city: 'London', country: 'UK' },
  { id: 'cinecitta', name: 'Cinecitta Studios', lat: 41.84, lon: 12.57, kind: 'studio', city: 'Rome', country: 'Italy' },
  { id: 'hengdian', name: 'Hengdian World Studios', lat: 29.14, lon: 120.28, kind: 'studio', city: 'Hengdian', country: 'China' },
  { id: 'nollywood', name: 'Nollywood', lat: 6.52, lon: 3.38, kind: 'hub', city: 'Lagos', country: 'Nigeria' },
  { id: 'chungmuro', name: 'Korean film industry', lat: 37.56, lon: 126.99, kind: 'hub', city: 'Seoul', country: 'South Korea' },
  { id: 'tokyo', name: 'Anime & film studios', lat: 35.70, lon: 139.70, kind: 'hub', city: 'Tokyo', country: 'Japan' },
];
