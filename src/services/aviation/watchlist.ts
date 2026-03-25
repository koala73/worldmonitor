/**
 * Aviation watchlist service — persists to localStorage.
 * Stores a short list of airports, airlines, and routes the user cares about.
 */

const STORAGE_KEY = 'aviation:watchlist:v1';

export interface AviationWatchlist {
  airports: string[];   // IATA codes e.g. ['IST','LHR']
  airlines: string[];   // IATA codes e.g. ['TK','LH']
  routes: string[];     // "ORG-DST" e.g. ['IST-LHR']
}

const DEFAULT_WATCHLIST: AviationWatchlist = {
  airports: ['IST', 'ESB', 'SAW', 'LHR', 'FRA', 'CDG', 'DXB', 'RUH'],
  airlines: ['TK'],
  routes: ['IST-LHR', 'IST-FRA'],
};

function load(): AviationWatchlist {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_WATCHLIST };
    const parsed = JSON.parse(raw) as Partial<AviationWatchlist>;
    return {
      airports: Array.isArray(parsed.airports) ? parsed.airports : DEFAULT_WATCHLIST.airports,
      airlines: Array.isArray(parsed.airlines) ? parsed.airlines : DEFAULT_WATCHLIST.airlines,
      routes: Array.isArray(parsed.routes) ? parsed.routes : DEFAULT_WATCHLIST.routes,
    };
  } catch {
    return { ...DEFAULT_WATCHLIST };
  }
}

function save(wl: AviationWatchlist): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(wl));
  } catch { /* storage quota */ }
}

export const aviationWatchlist = {
  get(): AviationWatchlist {
    return load();
  },

  set(wl: Partial<AviationWatchlist>): void {
    const current = load();
    save({ ...current, ...wl });
  },

  addAirport(iata: string): void {
    const wl = load();
    const code = iata.toUpperCase().trim();
    if (code && !wl.airports.includes(code)) {
      wl.airports = [...wl.airports, code].slice(0, 20);
      save(wl);
    }
  },

  removeAirport(iata: string): void {
    const wl = load();
    wl.airports = wl.airports.filter(a => a !== iata.toUpperCase());
    save(wl);
  },

  addAirline(iata: string): void {
    const wl = load();
    const code = iata.toUpperCase().trim();
    if (code && !wl.airlines.includes(code)) {
      wl.airlines = [...wl.airlines, code].slice(0, 10);
      save(wl);
    }
  },

  removeAirline(iata: string): void {
    const wl = load();
    wl.airlines = wl.airlines.filter(a => a !== iata.toUpperCase());
    save(wl);
  },

  addRoute(origin: string, destination: string): void {
    const wl = load();
    const route = `${origin.toUpperCase()}-${destination.toUpperCase()}`;
    if (!wl.routes.includes(route)) {
      wl.routes = [...wl.routes, route].slice(0, 20);
      save(wl);
    }
  },

  removeRoute(route: string): void {
    const wl = load();
    wl.routes = wl.routes.filter(r => r !== route);
    save(wl);
  },

  reset(): void {
    save({ ...DEFAULT_WATCHLIST });
  },
};
