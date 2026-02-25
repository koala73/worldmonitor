import { PORTS } from './ports';
import { STRATEGIC_WATERWAYS } from './geo';

export type TradeRouteCategory = 'container' | 'energy' | 'bulk';
export type TradeRouteStatus = 'active' | 'disrupted' | 'high_risk';

export interface TradeRoute {
  id: string;
  name: string;
  from: string;
  to: string;
  category: TradeRouteCategory;
  status: TradeRouteStatus;
  volumeDesc: string;
  waypoints: string[];
}

export interface TradeRouteSegment {
  routeId: string;
  routeName: string;
  category: TradeRouteCategory;
  status: TradeRouteStatus;
  volumeDesc: string;
  sourcePosition: [number, number];
  targetPosition: [number, number];
  segmentIndex: number;
  totalSegments: number;
}

export const TRADE_ROUTES: TradeRoute[] = [
  {
    id: 'china-europe-suez',
    name: 'China → Europe (Suez)',
    from: 'shanghai',
    to: 'rotterdam',
    category: 'container',
    status: 'active',
    volumeDesc: '47M+ TEU/year',
    waypoints: ['malacca_strait', 'bab_el_mandeb', 'suez'],
  },
  {
    id: 'china-us-west',
    name: 'China → US West Coast',
    from: 'shanghai',
    to: 'los_angeles',
    category: 'container',
    status: 'active',
    volumeDesc: '24M+ TEU/year',
    waypoints: ['taiwan_strait'],
  },
  {
    id: 'china-us-east-suez',
    name: 'China → US East Coast (Suez)',
    from: 'shenzhen',
    to: 'new_york_nj',
    category: 'container',
    status: 'active',
    volumeDesc: '12M+ TEU/year',
    waypoints: ['malacca_strait', 'bab_el_mandeb', 'suez'],
  },
  {
    id: 'china-us-east-panama',
    name: 'China → US East Coast (Panama)',
    from: 'guangzhou',
    to: 'new_york_nj',
    category: 'container',
    status: 'active',
    volumeDesc: '8M+ TEU/year',
    waypoints: ['panama'],
  },
  {
    id: 'gulf-europe-oil',
    name: 'Persian Gulf → Europe (Oil)',
    from: 'ras_tanura',
    to: 'rotterdam',
    category: 'energy',
    status: 'active',
    volumeDesc: '6.5M+ bpd',
    waypoints: ['hormuz_strait', 'bab_el_mandeb', 'suez', 'gibraltar'],
  },
  {
    id: 'gulf-asia-oil',
    name: 'Persian Gulf → Asia (Oil)',
    from: 'ras_tanura',
    to: 'singapore',
    category: 'energy',
    status: 'active',
    volumeDesc: '15M+ bpd',
    waypoints: ['hormuz_strait', 'malacca_strait'],
  },
  {
    id: 'qatar-europe-lng',
    name: 'Qatar LNG → Europe',
    from: 'ras_laffan',
    to: 'felixstowe',
    category: 'energy',
    status: 'active',
    volumeDesc: '77M+ tonnes/year',
    waypoints: ['hormuz_strait', 'bab_el_mandeb', 'suez'],
  },
  {
    id: 'qatar-asia-lng',
    name: 'Qatar LNG → Asia',
    from: 'ras_laffan',
    to: 'busan',
    category: 'energy',
    status: 'active',
    volumeDesc: '40M+ tonnes/year',
    waypoints: ['hormuz_strait', 'malacca_strait'],
  },
  {
    id: 'us-europe-lng',
    name: 'US LNG → Europe',
    from: 'sabine_pass',
    to: 'rotterdam',
    category: 'energy',
    status: 'active',
    volumeDesc: '80M+ tonnes/year',
    waypoints: [],
  },
  {
    id: 'russia-med-oil',
    name: 'Russia → Mediterranean (Oil)',
    from: 'novorossiysk',
    to: 'piraeus',
    category: 'energy',
    status: 'active',
    volumeDesc: '140M+ tonnes/year',
    waypoints: ['bosphorus'],
  },
  {
    id: 'intra-asia-container',
    name: 'Intra-Asia Container',
    from: 'singapore',
    to: 'busan',
    category: 'container',
    status: 'active',
    volumeDesc: '30M+ TEU/year',
    waypoints: ['taiwan_strait'],
  },
  {
    id: 'singapore-med',
    name: 'Singapore → Mediterranean',
    from: 'singapore',
    to: 'algeciras',
    category: 'container',
    status: 'active',
    volumeDesc: '10M+ TEU/year',
    waypoints: ['bab_el_mandeb', 'suez', 'gibraltar'],
  },
  {
    id: 'brazil-china-bulk',
    name: 'Brazil → China (Bulk)',
    from: 'santos',
    to: 'shanghai',
    category: 'bulk',
    status: 'active',
    volumeDesc: '350M+ tonnes/year',
    waypoints: [],
  },
  {
    id: 'india-europe',
    name: 'India → Europe',
    from: 'nhava_sheva',
    to: 'rotterdam',
    category: 'container',
    status: 'active',
    volumeDesc: '6M+ TEU/year',
    waypoints: ['bab_el_mandeb', 'suez', 'gibraltar'],
  },
  {
    id: 'india-se-asia',
    name: 'India → SE Asia',
    from: 'mundra',
    to: 'singapore',
    category: 'container',
    status: 'active',
    volumeDesc: '4M+ TEU/year',
    waypoints: ['malacca_strait'],
  },
  {
    id: 'china-africa',
    name: 'China → Africa',
    from: 'guangzhou',
    to: 'djibouti',
    category: 'container',
    status: 'active',
    volumeDesc: '5M+ TEU/year',
    waypoints: ['malacca_strait'],
  },
  {
    id: 'cpec-route',
    name: 'CPEC Route',
    from: 'gwadar',
    to: 'guangzhou',
    category: 'container',
    status: 'active',
    volumeDesc: '1M+ TEU/year',
    waypoints: ['malacca_strait'],
  },
  {
    id: 'panama-transit',
    name: 'Panama Transit',
    from: 'colon',
    to: 'balboa',
    category: 'container',
    status: 'active',
    volumeDesc: '14K+ transits/year',
    waypoints: ['panama'],
  },
  {
    id: 'transatlantic',
    name: 'TransAtlantic',
    from: 'new_york_nj',
    to: 'felixstowe',
    category: 'container',
    status: 'active',
    volumeDesc: '8M+ TEU/year',
    waypoints: [],
  },
];

export function resolveTradeRouteSegments(): TradeRouteSegment[] {
  const portMap = new Map<string, [number, number]>();
  for (const p of PORTS) portMap.set(p.id, [p.lon, p.lat]);

  const waterwayMap = new Map<string, [number, number]>();
  for (const w of STRATEGIC_WATERWAYS) waterwayMap.set(w.id, [w.lon, w.lat]);

  const segments: TradeRouteSegment[] = [];

  for (const route of TRADE_ROUTES) {
    const fromCoord = portMap.get(route.from);
    const toCoord = portMap.get(route.to);
    if (!fromCoord || !toCoord) {
      if (import.meta.env.DEV) console.error(`[trade-routes] Missing port: ${!fromCoord ? route.from : route.to}`);
      continue;
    }

    const waypointCoords: [number, number][] = [];
    let valid = true;
    for (const wpId of route.waypoints) {
      const coord = waterwayMap.get(wpId);
      if (!coord) {
        if (import.meta.env.DEV) console.error(`[trade-routes] Missing waterway: ${wpId}`);
        valid = false;
        break;
      }
      waypointCoords.push(coord);
    }
    if (!valid) continue;

    const chain: [number, number][] = [fromCoord, ...waypointCoords, toCoord];
    const totalSegments = chain.length - 1;

    for (let i = 0; i < totalSegments; i++) {
      segments.push({
        routeId: route.id,
        routeName: route.name,
        category: route.category,
        status: route.status,
        volumeDesc: route.volumeDesc,
        sourcePosition: chain[i]!,
        targetPosition: chain[i + 1]!,
        segmentIndex: i,
        totalSegments,
      });
    }
  }

  return segments;
}

let validRouteIds: Set<string> | null = null;

export function getChokepointRoutes(waterwayId: string): TradeRoute[] {
  if (!validRouteIds) {
    validRouteIds = new Set(resolveTradeRouteSegments().map(s => s.routeId));
  }
  return TRADE_ROUTES.filter(r => validRouteIds!.has(r.id) && r.waypoints.includes(waterwayId));
}
