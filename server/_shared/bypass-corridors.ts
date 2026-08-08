export type BypassType = 'alternative_sea_route' | 'land_bridge' | 'modal_shift' | 'pipeline';
export type CargoType = 'container' | 'tanker' | 'bulk' | 'roro';
export type ActivationThreshold = 'partial_closure' | 'full_closure';

export interface BypassCorridor {
  id: string;
  name: string;
  primaryChokepointId: string;
  type: BypassType;
  waypointChokepointIds: string[];
  addedTransitDays: number;
  addedCostMultiplier: number;
  capacityConstraintTonnage: number | null;
  suitableCargoTypes: CargoType[];
  activationThreshold: ActivationThreshold;
  notes: string;
}

export const BYPASS_CORRIDORS: readonly BypassCorridor[] = [
  // ── Suez Canal bypasses ────────────────────────────────────────────────
  {
    id: 'suez_cape_of_good_hope',
    name: 'Cape of Good Hope Route',
    primaryChokepointId: 'suez',
    type: 'alternative_sea_route',
    waypointChokepointIds: ['cape_of_good_hope'],
    addedTransitDays: 12,
    addedCostMultiplier: 1.18,
    capacityConstraintTonnage: null,
    suitableCargoTypes: ['container', 'tanker', 'bulk', 'roro'],
    activationThreshold: 'partial_closure',
    notes: 'Primary diversion route for Asia-Europe traffic avoiding the Red Sea',
  },
  {
    id: 'sumed_pipeline',
    name: 'SUMED Pipeline',
    primaryChokepointId: 'suez',
    type: 'pipeline',
    waypointChokepointIds: [],
    addedTransitDays: 2,
    addedCostMultiplier: 1.05,
    capacityConstraintTonnage: 210,
    suitableCargoTypes: ['tanker'],
    activationThreshold: 'partial_closure',
    notes: 'Suez-Mediterranean Pipeline; crude only; 210 Mt/yr capacity',
  },

  // ── Strait of Hormuz bypasses ─────────────────────────────────────────
  {
    id: 'hormuz_cape_of_good_hope',
    name: 'Cape of Good Hope Route',
    primaryChokepointId: 'hormuz_strait',
    type: 'alternative_sea_route',
    waypointChokepointIds: ['cape_of_good_hope'],
    addedTransitDays: 16,
    addedCostMultiplier: 1.25,
    capacityConstraintTonnage: null,
    suitableCargoTypes: ['container', 'tanker', 'bulk', 'roro'],
    activationThreshold: 'partial_closure',
    notes: 'Long-haul diversion bypassing Gulf and Indian Ocean choke via the Cape',
  },
  {
    id: 'aqaba_land_bridge',
    name: 'Aqaba Land Bridge',
    primaryChokepointId: 'hormuz_strait',
    type: 'land_bridge',
    waypointChokepointIds: [],
    addedTransitDays: 5,
    addedCostMultiplier: 1.35,
    capacityConstraintTonnage: 15,
    suitableCargoTypes: ['container', 'roro'],
    activationThreshold: 'partial_closure',
    notes: 'Road/rail transit via Jordan to the port of Aqaba; 15 Mt/yr capacity constraint',
  },
  {
    id: 'btc_pipeline',
    name: 'BTC Pipeline (Baku-Tbilisi-Ceyhan)',
    primaryChokepointId: 'hormuz_strait',
    type: 'pipeline',
    waypointChokepointIds: [],
    addedTransitDays: 3,
    addedCostMultiplier: 1.1,
    capacityConstraintTonnage: 28,
    suitableCargoTypes: ['tanker'],
    activationThreshold: 'partial_closure',
    notes: 'Crude oil pipeline from Caspian to Turkish Mediterranean; 28 Mt/yr capacity',
  },

  // ── Strait of Malacca bypasses ────────────────────────────────────────
  {
    id: 'lombok_strait_bypass',
    name: 'Lombok Strait',
    primaryChokepointId: 'malacca_strait',
    type: 'alternative_sea_route',
    waypointChokepointIds: ['lombok_strait'],
    addedTransitDays: 2,
    addedCostMultiplier: 1.05,
    capacityConstraintTonnage: null,
    suitableCargoTypes: ['tanker', 'bulk'],
    activationThreshold: 'partial_closure',
    notes: 'Preferred tanker and bulk diversion for vessels too large for Malacca',
  },
  {
    id: 'sunda_strait',
    name: 'Sunda Strait',
    primaryChokepointId: 'malacca_strait',
    type: 'alternative_sea_route',
    waypointChokepointIds: [],
    addedTransitDays: 1,
    addedCostMultiplier: 1.03,
    capacityConstraintTonnage: null,
    suitableCargoTypes: ['container', 'tanker', 'bulk', 'roro'],
    activationThreshold: 'partial_closure',
    notes: 'Narrower and shallower than Lombok; suitable for most vessel classes',
  },
  {
    id: 'kra_canal_future',
    name: 'Kra Canal (Proposed)',
    primaryChokepointId: 'malacca_strait',
    type: 'alternative_sea_route',
    waypointChokepointIds: [],
    addedTransitDays: 0,
    addedCostMultiplier: 0.95,
    capacityConstraintTonnage: null,
    suitableCargoTypes: ['container', 'tanker', 'bulk', 'roro'],
    activationThreshold: 'full_closure',
    notes: 'Proposed; not yet constructed',
  },

  // ── Bab el-Mandeb bypasses ────────────────────────────────────────────
  {
    id: 'bab_el_mandeb_cape_of_good_hope',
    name: 'Cape of Good Hope Route',
    primaryChokepointId: 'bab_el_mandeb',
    type: 'alternative_sea_route',
    waypointChokepointIds: ['cape_of_good_hope'],
    addedTransitDays: 10,
    addedCostMultiplier: 1.15,
    capacityConstraintTonnage: null,
    suitableCargoTypes: ['container', 'tanker', 'bulk', 'roro'],
    activationThreshold: 'partial_closure',
    notes: 'Standard diversion for vessels avoiding the Red Sea / Houthi threat zone',
  },
  {
    id: 'djibouti_rail',
    name: 'Djibouti-Addis Ababa Railway',
    primaryChokepointId: 'bab_el_mandeb',
    type: 'land_bridge',
    waypointChokepointIds: [],
    addedTransitDays: 7,
    addedCostMultiplier: 1.45,
    capacityConstraintTonnage: 1,
    suitableCargoTypes: ['container'],
    activationThreshold: 'full_closure',
    notes: 'Containerised cargo only; 1 Mt/yr capacity; requires full closure to justify costs',
  },

  // ── Bosporus Strait bypasses ──────────────────────────────────────────
  {
    id: 'btc_pipeline_black_sea',
    name: 'BTC Pipeline (Black Sea crude egress)',
    primaryChokepointId: 'bosphorus',
    type: 'pipeline',
    waypointChokepointIds: [],
    addedTransitDays: 2,
    addedCostMultiplier: 1.08,
    capacityConstraintTonnage: 28,
    suitableCargoTypes: ['tanker'],
    activationThreshold: 'partial_closure',
    notes: 'Crude oil pipeline from Baku; avoids tanker transit through the Bosphorus',
  },
  {
    id: 'baku_tbilisi_batumi_rail',
    name: 'Baku-Tbilisi-Batumi Rail Corridor',
    primaryChokepointId: 'bosphorus',
    type: 'land_bridge',
    waypointChokepointIds: [],
    addedTransitDays: 4,
    addedCostMultiplier: 1.3,
    capacityConstraintTonnage: 8,
    suitableCargoTypes: ['container', 'bulk'],
    activationThreshold: 'partial_closure',
    notes: 'Multimodal corridor via Georgia to Black Sea port of Batumi; 8 Mt/yr capacity',
  },

  // ── Panama Canal bypasses ─────────────────────────────────────────────
  {
    id: 'panama_cape_horn',
    name: 'Cape Horn Route',
    primaryChokepointId: 'panama',
    type: 'alternative_sea_route',
    waypointChokepointIds: [],
    addedTransitDays: 22,
    addedCostMultiplier: 1.4,
    capacityConstraintTonnage: null,
    suitableCargoTypes: ['container', 'tanker', 'bulk', 'roro'],
    activationThreshold: 'full_closure',
    notes: 'Historically significant; high seas and extreme weather make it a last resort',
  },
  {
    id: 'us_rail_landbridge',
    name: 'US Rail Land Bridge',
    primaryChokepointId: 'panama',
    type: 'land_bridge',
    waypointChokepointIds: [],
    addedTransitDays: 6,
    addedCostMultiplier: 1.55,
    capacityConstraintTonnage: 2,
    suitableCargoTypes: ['container'],
    activationThreshold: 'partial_closure',
    notes: 'Intermodal rail across the continental US; 2 Mt/yr capacity; containers only',
  },

  // ── Taiwan Strait bypasses ────────────────────────────────────────────
  {
    id: 'bashi_channel',
    name: 'Bashi Channel',
    primaryChokepointId: 'taiwan_strait',
    type: 'alternative_sea_route',
    waypointChokepointIds: [],
    addedTransitDays: 1,
    addedCostMultiplier: 1.04,
    capacityConstraintTonnage: null,
    suitableCargoTypes: ['container', 'tanker', 'bulk', 'roro'],
    activationThreshold: 'partial_closure',
    notes: 'Deep-water channel between Taiwan and the Philippines; suitable for all vessel classes',
  },
  {
    id: 'miyako_strait',
    name: 'Miyako Strait',
    primaryChokepointId: 'taiwan_strait',
    type: 'alternative_sea_route',
    waypointChokepointIds: [],
    addedTransitDays: 1,
    addedCostMultiplier: 1.04,
    capacityConstraintTonnage: null,
    suitableCargoTypes: ['container', 'tanker', 'bulk', 'roro'],
    activationThreshold: 'partial_closure',
    notes: 'Between Miyako Island and Okinawa; monitored by Japan Maritime Self-Defense Force',
  },

  // ── Dover Strait bypasses ─────────────────────────────────────────────
  {
    id: 'north_sea_scotland',
    name: 'North Sea / Scotland Route',
    primaryChokepointId: 'dover_strait',
    type: 'alternative_sea_route',
    waypointChokepointIds: [],
    addedTransitDays: 1,
    addedCostMultiplier: 1.02,
    capacityConstraintTonnage: null,
    suitableCargoTypes: ['container', 'tanker', 'bulk', 'roro'],
    activationThreshold: 'partial_closure',
    notes: 'Northern route around Scotland; minor added distance for most vessel types',
  },
  {
    id: 'channel_tunnel',
    name: 'Channel Tunnel (Rail Freight)',
    primaryChokepointId: 'dover_strait',
    type: 'modal_shift',
    waypointChokepointIds: [],
    addedTransitDays: 1,
    addedCostMultiplier: 1.35,
    capacityConstraintTonnage: 0.5,
    suitableCargoTypes: ['container'],
    activationThreshold: 'full_closure',
    notes: 'Rail freight via Eurotunnel; 0.5 Mt/yr capacity; containers only; requires full closure to justify modal shift',
  },

  // ── Strait of Gibraltar ───────────────────────────────────────────────
  {
    id: 'gibraltar_no_bypass',
    name: 'No Practical Bypass',
    primaryChokepointId: 'gibraltar',
    type: 'alternative_sea_route',
    waypointChokepointIds: [],
    addedTransitDays: 0,
    addedCostMultiplier: 1.0,
    capacityConstraintTonnage: null,
    suitableCargoTypes: [],
    activationThreshold: 'full_closure',
    notes: 'No practical bypass — all Atlantic-Med traffic transits here',
  },

  // ── Cape of Good Hope ─────────────────────────────────────────────────
  {
    id: 'cape_of_good_hope_is_bypass',
    name: 'Cape of Good Hope (Is a Bypass Route)',
    primaryChokepointId: 'cape_of_good_hope',
    type: 'alternative_sea_route',
    waypointChokepointIds: [],
    addedTransitDays: 0,
    addedCostMultiplier: 1.0,
    capacityConstraintTonnage: null,
    suitableCargoTypes: [],
    activationThreshold: 'full_closure',
    notes: 'Cape of Good Hope IS a bypass route for Suez/Bab-el-Mandeb — no secondary bypass available',
  },

  // ── Korea Strait bypasses ─────────────────────────────────────────────
  {
    id: 'la_perouse_strait',
    name: 'La Perouse Strait (Soya Strait)',
    primaryChokepointId: 'korea_strait',
    type: 'alternative_sea_route',
    waypointChokepointIds: [],
    addedTransitDays: 2,
    addedCostMultiplier: 1.06,
    capacityConstraintTonnage: null,
    suitableCargoTypes: ['container', 'tanker', 'bulk'],
    activationThreshold: 'partial_closure',
    notes: 'Seasonal — limited ice conditions Nov-Apr',
  },
  {
    id: 'tsugaru_strait',
    name: 'Tsugaru Strait',
    primaryChokepointId: 'korea_strait',
    type: 'alternative_sea_route',
    waypointChokepointIds: [],
    addedTransitDays: 1,
    addedCostMultiplier: 1.04,
    capacityConstraintTonnage: null,
    suitableCargoTypes: ['container', 'tanker', 'bulk', 'roro'],
    activationThreshold: 'partial_closure',
    notes: 'Between Hokkaido and Honshu; narrower but ice-free year-round',
  },

  // ── Kerch Strait bypasses ─────────────────────────────────────────────
  {
    id: 'black_sea_western_ports',
    name: 'Black Sea Western Ports Reroute',
    primaryChokepointId: 'kerch_strait',
    type: 'alternative_sea_route',
    waypointChokepointIds: [],
    addedTransitDays: 3,
    addedCostMultiplier: 1.2,
    capacityConstraintTonnage: null,
    suitableCargoTypes: ['tanker', 'bulk'],
    activationThreshold: 'partial_closure',
    notes: 'Reroute to Constanta/Odesa/Varna; effectively blockaded since Feb 2022',
  },
  {
    id: 'ukraine_rail_reroute',
    name: 'Ukraine Rail Reroute',
    primaryChokepointId: 'kerch_strait',
    type: 'land_bridge',
    waypointChokepointIds: [],
    addedTransitDays: 5,
    addedCostMultiplier: 1.4,
    capacityConstraintTonnage: 2,
    suitableCargoTypes: ['container'],
    activationThreshold: 'full_closure',
    notes: 'Rail through Ukraine to EU entry points; 2 Mt/yr capacity; significant geopolitical risk',
  },

  // ── Lombok Strait bypasses ────────────────────────────────────────────
  {
    id: 'sunda_strait_for_lombok',
    name: 'Sunda Strait',
    primaryChokepointId: 'lombok_strait',
    type: 'alternative_sea_route',
    waypointChokepointIds: [],
    addedTransitDays: 1,
    addedCostMultiplier: 1.03,
    capacityConstraintTonnage: null,
    suitableCargoTypes: ['tanker', 'bulk', 'container'],
    activationThreshold: 'partial_closure',
    notes: 'Shallower than Lombok; suitable for most vessel classes except VLCCs',
  },
  {
    id: 'ombai_strait',
    name: 'Ombai Strait',
    primaryChokepointId: 'lombok_strait',
    type: 'alternative_sea_route',
    waypointChokepointIds: [],
    addedTransitDays: 1,
    addedCostMultiplier: 1.02,
    capacityConstraintTonnage: null,
    suitableCargoTypes: ['tanker', 'bulk'],
    activationThreshold: 'partial_closure',
    notes: 'Deep-water passage between Alor and Timor; primarily tanker and bulk',
  },
];

export const BYPASS_CORRIDORS_BY_CHOKEPOINT: Readonly<Record<string, readonly BypassCorridor[]>> =
  BYPASS_CORRIDORS.reduce((acc, c) => {
    (acc[c.primaryChokepointId] ??= []).push(c);
    return acc;
  }, {} as Record<string, BypassCorridor[]>);
