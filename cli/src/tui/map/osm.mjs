// Street-level styling: turns OpenMapTiles vector-tile layers into map
// features (roads, railways, buildings, water, parks, places, points of
// interest, places of worship, street names, house numbers, peaks) with the
// level of detail Google-style maps use: motorways first, lanes and house
// numbers only when you are really close.
import { mercLat } from './geo.mjs';

export const STREET_GROUP = { id: 'street', label: 'Street level' };

// Layer toggles for the sidebar (ids are referenced by features' `layer`).
export const STREET_LAYERS = [
  { id: 'water', label: 'Water & rivers', glyph: '≈', color: 'info', on: true, minZ: 5 },
  { id: 'landuse', label: 'Parks, forests & land use', glyph: '♣', color: 'good', on: true, minZ: 9 },
  { id: 'buildings', label: 'Buildings', glyph: '▪', color: 'text', on: true, minZ: 13 },
  { id: 'roads', label: 'Roads', glyph: '─', color: 'warn', on: true, minZ: 5 },
  { id: 'rail', label: 'Railways & transit', glyph: '┄', color: 'muted', on: true, minZ: 8 },
  { id: 'aeroway', label: 'Airports & runways', glyph: '✈', color: 'dim', on: true, minZ: 10 },
  { id: 'boundaries', label: 'Administrative boundaries', glyph: '╌', color: 'muted', on: true, minZ: 4 },
  { id: 'places', label: 'Cities, towns & villages', glyph: '●', color: 'text', on: true, minZ: 4 },
  { id: 'streetNames', label: 'Street names', glyph: 'A', color: 'dim', on: true, minZ: 13 },
  { id: 'pois', label: 'Shops, services & amenities', glyph: '◫', color: 'accent', on: true, minZ: 11 },
  { id: 'worship', label: 'Places of worship', glyph: '☪', color: 'good', on: true, minZ: 11 },
  { id: 'housenumbers', label: 'House numbers', glyph: '#', color: 'muted', on: true, minZ: 17 },
  { id: 'peaks', label: 'Mountain peaks', glyph: '▲', color: 'text', on: true, minZ: 9 },
  { id: 'wikipedia', label: 'Wikipedia nearby', glyph: 'W', color: 'accent3', on: true, minZ: 11, service: true },
  { id: 'aircraftAll', label: 'All aircraft (ADS-B)', glyph: '✈', color: 'accent', on: false, minZ: 6, service: true },
];

export const STREET_LAYER_IDS = STREET_LAYERS.map((l) => l.id);

// Road classes by the tile zoom at which they appear, their colour and weight.
const ROADS = {
  motorway: { minZ: 5, weight: 2, key: 'warn', label: 'Motorway' },
  trunk: { minZ: 6, weight: 2, key: 'warn', label: 'Trunk road' },
  primary: { minZ: 8, weight: 2, key: 'accent2', label: 'Primary road' },
  secondary: { minZ: 10, weight: 1, key: 'text', label: 'Secondary road' },
  tertiary: { minZ: 12, weight: 1, key: 'text', label: 'Tertiary road' },
  minor: { minZ: 13, weight: 1, key: 'dim', label: 'Street' },
  service: { minZ: 15, weight: 0, key: 'dim', label: 'Service road' },
  track: { minZ: 14, weight: 0, key: 'muted', label: 'Track', dash: 3 },
  path: { minZ: 15, weight: 0, key: 'muted', label: 'Path', dash: 2 },
  raceway: { minZ: 13, weight: 1, key: 'accent2', label: 'Raceway' },
  busway: { minZ: 13, weight: 1, key: 'accent3', label: 'Busway' },
};

const RAIL = { rail: 'Railway', transit: 'Transit line', subway: 'Subway', tram: 'Tram', light_rail: 'Light rail', monorail: 'Monorail', funicular: 'Funicular', ferry: 'Ferry route', cable_car: 'Cable car', gondola: 'Gondola', aerialway: 'Aerial way', narrow_gauge: 'Narrow-gauge railway' };

// Points of interest: class → glyph, colour key, label, and the tile zoom they appear at.
const POI = {
  hospital: ['✚', 'bad', 'Hospital', 11],
  doctors: ['✚', 'bad', 'Doctor', 15],
  dentist: ['✚', 'bad', 'Dentist', 16],
  clinic: ['✚', 'bad', 'Clinic', 14],
  pharmacy: ['℞', 'bad', 'Pharmacy', 14],
  veterinary: ['✚', 'warn', 'Veterinary', 16],
  school: ['✎', 'info', 'School', 13],
  college: ['✎', 'info', 'College', 12],
  university: ['✎', 'info', 'University', 11],
  kindergarten: ['✎', 'info', 'Kindergarten', 15],
  library: ['≣', 'info', 'Library', 13],
  bank: ['¤', 'warn', 'Bank', 14],
  atm: ['¤', 'warn', 'ATM', 16],
  bureau_de_change: ['¤', 'warn', 'Currency exchange', 16],
  restaurant: ['♨', 'warn', 'Restaurant', 14],
  fast_food: ['♨', 'warn', 'Fast food', 15],
  cafe: ['♨', 'warn', 'Café', 15],
  bar: ['♨', 'warn', 'Bar', 15],
  pub: ['♨', 'warn', 'Pub', 15],
  ice_cream: ['♨', 'warn', 'Ice cream', 16],
  bakery: ['♨', 'warn', 'Bakery', 15],
  shop: ['◫', 'accent', 'Shop', 15],
  grocery: ['◫', 'accent', 'Grocery', 14],
  clothing_store: ['◫', 'accent', 'Clothing store', 15],
  alcohol_shop: ['◫', 'accent', 'Liquor store', 16],
  butcher: ['◫', 'accent', 'Butcher', 16],
  hairdresser: ['◫', 'accent', 'Hairdresser', 16],
  laundry: ['◫', 'accent', 'Laundry', 16],
  car: ['◫', 'accent', 'Car dealer / repair', 15],
  car_repair: ['◫', 'accent', 'Car repair', 16],
  bicycle: ['◫', 'accent', 'Bicycle shop', 16],
  bicycle_rental: ['◫', 'accent', 'Bicycle rental', 16],
  lodging: ['⌂', 'info', 'Hotel', 13],
  fuel: ['⬡', 'warn', 'Fuel station', 13],
  charging_station: ['⬡', 'good', 'Charging station', 15],
  parking: ['P', 'dim', 'Parking', 15],
  toilets: ['⊡', 'dim', 'Toilets', 16],
  drinking_water: ['⌇', 'info', 'Drinking water', 16],
  bus: ['⊙', 'accent3', 'Bus stop', 14],
  railway: ['⊙', 'accent3', 'Railway station', 10],
  subway: ['⊙', 'accent3', 'Subway station', 12],
  tram: ['⊙', 'accent3', 'Tram stop', 14],
  ferry_terminal: ['⊙', 'accent3', 'Ferry terminal', 12],
  airport: ['✈', 'accent3', 'Airport', 9],
  aerodrome: ['✈', 'accent3', 'Aerodrome', 10],
  helicopter: ['✈', 'accent3', 'Heliport', 14],
  park: ['♣', 'good', 'Park', 12],
  garden: ['♣', 'good', 'Garden', 15],
  playground: ['♣', 'good', 'Playground', 16],
  cemetery: ['✝', 'dim', 'Cemetery', 14],
  dog_park: ['♣', 'good', 'Dog park', 16],
  golf: ['♣', 'good', 'Golf course', 13],
  stadium: ['◎', 'accent2', 'Stadium', 11],
  pitch: ['◎', 'good', 'Sports pitch', 16],
  swimming_pool: ['≈', 'info', 'Swimming pool', 15],
  attraction: ['★', 'accent2', 'Attraction', 12],
  museum: ['★', 'accent2', 'Museum', 12],
  art_gallery: ['★', 'accent2', 'Art gallery', 14],
  monument: ['★', 'accent2', 'Monument', 13],
  castle: ['♜', 'accent2', 'Castle', 11],
  theatre: ['★', 'accent2', 'Theatre', 13],
  cinema: ['★', 'accent2', 'Cinema', 14],
  zoo: ['★', 'accent2', 'Zoo', 12],
  information: ['i', 'info', 'Tourist information', 15],
  police: ['☗', 'bad', 'Police', 13],
  fire_station: ['✸', 'bad', 'Fire station', 13],
  prison: ['▣', 'dim', 'Prison', 13],
  town_hall: ['⌂', 'text', 'Town hall', 12],
  office: ['⌂', 'text', 'Office', 16],
  embassy: ['⌂', 'text', 'Embassy', 13],
  courthouse: ['⌂', 'text', 'Courthouse', 13],
  post: ['✉', 'info', 'Post office', 15],
  marketplace: ['◫', 'accent', 'Market', 14],
  entrance: ['▫', 'muted', 'Entrance', 17],
  lift_gate: ['▫', 'muted', 'Gate', 17],
  brownfield: ['▫', 'muted', 'Brownfield', 15],
  place_of_worship: ['⌂', 'good', 'Place of worship', 11],
};

const WORSHIP = {
  muslim: ['☪', 'Mosque'],
  christian: ['✝', 'Church'],
  jewish: ['✡', 'Synagogue'],
  buddhist: ['☸', 'Buddhist temple'],
  hindu: ['ॐ', 'Hindu temple'],
  sikh: ['☬', 'Gurdwara'],
  taoist: ['☯', 'Taoist temple'],
  shinto: ['⛩', 'Shinto shrine'],
  bahai: ['✶', "Bahá'í house of worship"],
  jain: ['卍', 'Jain temple'],
  zoroastrian: ['✴', 'Fire temple'],
};

const PLACE = {
  continent: { minZ: 0, size: 3, upper: true, key: 'dim' },
  country: { minZ: 2, size: 3, upper: true, key: 'dim' },
  state: { minZ: 5, size: 2, upper: true, key: 'muted' },
  province: { minZ: 5, size: 2, upper: true, key: 'muted' },
  city: { minZ: 4, size: 2, key: 'text' },
  town: { minZ: 8, size: 1, key: 'text' },
  village: { minZ: 11, size: 1, key: 'dim' },
  suburb: { minZ: 12, size: 1, key: 'dim' },
  quarter: { minZ: 13, size: 0, key: 'dim' },
  neighbourhood: { minZ: 13, size: 0, key: 'muted' },
  hamlet: { minZ: 13, size: 0, key: 'muted' },
  island: { minZ: 10, size: 1, key: 'dim' },
  isolated_dwelling: { minZ: 15, size: 0, key: 'muted' },
  aboriginal_lands: { minZ: 8, size: 1, key: 'muted' },
};

export function displayName(props) {
  const local = props.name || '';
  const intl = props['name:en'] || props.name_en || props.name_int || '';
  if (intl && intl !== local) return { name: intl, local };
  return { name: local || intl, local: '' };
}

function worshipIcon(subclass) {
  const w = WORSHIP[subclass];
  return w ? { glyph: w[0], kind: w[1] } : { glyph: '⌂', kind: 'Place of worship' };
}

function poiStyle(props, t) {
  const cls = props.class;
  if (cls === 'place_of_worship') {
    const icon = worshipIcon(props.subclass);
    return { glyph: icon.glyph, color: t.good, kind: icon.kind, minZ: 11, layer: 'worship', bold: true };
  }
  const p = POI[cls] || POI[props.subclass];
  if (p) return { glyph: p[0], color: t[p[1]] || t.text, kind: p[2], minZ: p[3], layer: 'pois' };
  return { glyph: '•', color: t.dim, kind: `${(props.subclass || cls || 'place').replace(/_/g, ' ')}`, minZ: 16, layer: 'pois' };
}

const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1).replace(/_/g, ' ') : '');
const info = (pairs) => pairs.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)]);

// Convert one decoded tile into features. `tileZoom` is the viewer's fractional
// zoom (used for level of detail); z/x/y identify the tile (which may be shallower
// than tileZoom when overzooming).
export function tileFeatures(tile, z, x, y, { t, tileZoom, enabled, limit = 2500 } = {}) {
  const out = [];
  const n = 2 ** z;
  const lonOf = (px, extent) => ((x + px / extent) / n) * 360 - 180;
  const latOf = (py, extent) => mercLat(Math.PI - ((y + py / extent) / n) * 2 * Math.PI);
  const toLL = (pt, extent) => [lonOf(pt[0], extent), latOf(pt[1], extent)];
  const ringLL = (ring, extent) => ring.map((p) => toLL(p, extent));
  const on = (id) => !enabled || enabled[id] !== false;
  const zoomLod = tileZoom ?? z;
  const push = (f) => {
    if (out.length < limit) out.push(f);
  };
  const idOf = (prefix, f, i) => `${prefix}:${z}/${x}/${y}:${f.id ?? i}`;
  const centroid = (ring) => {
    let sx = 0;
    let sy = 0;
    for (const [px, py] of ring) {
      sx += px;
      sy += py;
    }
    return [sx / ring.length, sy / ring.length];
  };

  const L = tile.layers;

  if (on('water') && zoomLod >= 5 && L.water) {
    L.water.features.forEach((f, i) => {
      if (f.type !== 3) return;
      const rings = f.geometry.map((r) => ringLL(r, L.water.extent));
      const c = toLL(centroid(f.geometry[0]), L.water.extent);
      push({ id: idOf('water', f, i), layer: 'water', name: displayName(f.props).name || cap(f.props.class) || 'Water', rings, lon: c[0], lat: c[1], glyph: '≈', color: t.info, size: 0, fillOnly: true, info: info([['Type', cap(f.props.class || 'water')], ['Intermittent', f.props.intermittent ? 'yes' : '']]) });
    });
  }
  if (on('water') && zoomLod >= 8 && L.waterway) {
    L.waterway.features.forEach((f, i) => {
      if (f.type !== 2) return;
      const cls = f.props.class;
      if (cls === 'stream' && zoomLod < 13) return;
      if ((cls === 'ditch' || cls === 'drain' || cls === 'canal') && zoomLod < 12) return;
      const { name, local } = displayName(f.props);
      for (const line of f.geometry) {
        const pts = ringLL(line, L.waterway.extent);
        push({ id: idOf('waterway', f, i), layer: 'water', name: name || cap(cls), points: pts, lon: pts[0][0], lat: pts[0][1], glyph: '≈', color: t.info, size: cls === 'river' ? 1 : 0, info: info([['Type', cap(cls)], ['Local name', local]]) });
      }
    });
  }
  if (on('landuse') && zoomLod >= 9) {
    for (const [layerName, kinds] of [['park', null], ['landcover', { wood: 'Forest', grass: 'Grass', farmland: 'Farmland', wetland: 'Wetland', ice: 'Glacier', sand: 'Sand', rock: 'Rock' }], ['landuse', { residential: 'Residential area', commercial: 'Commercial area', industrial: 'Industrial area', retail: 'Retail area', cemetery: 'Cemetery', hospital: 'Hospital grounds', school: 'School grounds', university: 'University', college: 'College', stadium: 'Stadium', pitch: 'Sports pitch', playground: 'Playground', military: 'Military area', railway: 'Railway land', quarry: 'Quarry', garages: 'Garages', dam: 'Dam', theme_park: 'Theme park', zoo: 'Zoo', bus_station: 'Bus station', track: 'Track' }]]) {
      const layer = L[layerName];
      if (!layer) continue;
      layer.features.forEach((f, i) => {
        if (f.type !== 3) return;
        const cls = f.props.class || f.props.subclass;
        const kind = layerName === 'park' ? cap(cls || 'park') : kinds[cls] || cap(cls);
        const green = layerName === 'park' || ['wood', 'grass', 'wetland', 'farmland', 'cemetery', 'pitch', 'playground', 'golf'].includes(cls);
        const color = green ? t.good : /residential|retail|commercial/.test(cls || '') ? t.accent3 : /industrial|quarry|railway|garages/.test(cls || '') ? t.warn : /military/.test(cls || '') ? t.bad : t.dim;
        const rings = f.geometry.map((r) => ringLL(r, layer.extent));
        const c = toLL(centroid(f.geometry[0]), layer.extent);
        const { name, local } = displayName(f.props);
        push({ id: idOf(layerName, f, i), layer: 'landuse', name: name || kind, rings, lon: c[0], lat: c[1], glyph: '♣', color, size: 0, fillOnly: true, fillPattern: 2, info: info([['Type', kind], ['Local name', local]]) });
      });
    }
  }
  if (on('buildings') && zoomLod >= 13 && L.building) {
    const outline = zoomLod >= 16;
    L.building.features.forEach((f, i) => {
      if (f.type !== 3) return;
      const h = Number(f.props.render_height) || 0;
      const rings = f.geometry.map((r) => ringLL(r, L.building.extent));
      const c = toLL(centroid(f.geometry[0]), L.building.extent);
      push({ id: idOf('bld', f, i), layer: 'buildings', name: h >= 50 ? `Tall building (${Math.round(h)} m)` : 'Building', rings, lon: c[0], lat: c[1], glyph: '▪', color: h >= 50 ? t.text : h >= 20 ? mixish(t) : t.dim, size: 0, fillOnly: !outline, fillPattern: 2, info: info([['Height', h ? `${Math.round(h)} m` : ''], ['Colour', f.props.colour], ['OSM way', f.id]]) });
    });
  }
  if (L.transportation) {
    L.transportation.features.forEach((f, i) => {
      if (f.type !== 2) return;
      const cls = f.props.class;
      const rail = RAIL[cls] || (cls === 'transit' ? 'Transit line' : null);
      if (rail) {
        if (!on('rail') || zoomLod < 8 || (zoomLod < 12 && !/rail|transit|ferry/.test(cls))) return;
        for (const line of f.geometry) {
          const pts = ringLL(line, L.transportation.extent);
          push({ id: idOf('rail', f, i), layer: 'rail', name: `${rail}${f.props.service ? ` (${f.props.service})` : ''}`, points: pts, lon: pts[0][0], lat: pts[0][1], glyph: '┄', color: t.muted, size: 0, dash: 3, info: info([['Type', rail], ['Service', f.props.service], ['Bridge/tunnel', f.props.brunnel]]) });
        }
        return;
      }
      if (cls === 'aerialway' || cls === 'runway' || cls === 'taxiway') return;
      const base = cls && cls.endsWith('_construction') ? cls.replace('_construction', '') : cls;
      const style = ROADS[base];
      if (!style || !on('roads')) return;
      if (zoomLod < style.minZ) return;
      const construction = base !== cls;
      for (const line of f.geometry) {
        const pts = ringLL(line, L.transportation.extent);
        push({ id: idOf('road', f, i), layer: 'roads', name: `${style.label}${f.props.ref ? ` ${f.props.ref}` : ''}${construction ? ' (under construction)' : ''}`, points: pts, lon: pts[0][0], lat: pts[0][1], glyph: '─', color: construction ? t.muted : t[style.key] || t.text, size: style.weight, dash: construction ? 2 : style.dash || 0, roadClass: base, info: info([['Class', style.label], ['Ref', f.props.ref], ['Surface', f.props.surface], ['One way', f.props.oneway ? 'yes' : ''], ['Bridge/tunnel', f.props.brunnel], ['Layer', f.props.layer], ['Toll', f.props.toll ? 'yes' : '']]) });
      }
    });
  }
  if (on('aeroway') && zoomLod >= 10 && L.aeroway) {
    L.aeroway.features.forEach((f, i) => {
      const cls = f.props.class;
      if (f.type === 2) {
        for (const line of f.geometry) {
          const pts = ringLL(line, L.aeroway.extent);
          push({ id: idOf('aero', f, i), layer: 'aeroway', name: cap(cls), points: pts, lon: pts[0][0], lat: pts[0][1], glyph: '═', color: t.dim, size: cls === 'runway' ? 2 : 0, info: info([['Type', cap(cls)], ['Ref', f.props.ref]]) });
        }
      } else if (f.type === 3) {
        const rings = f.geometry.map((r) => ringLL(r, L.aeroway.extent));
        const c = toLL(centroid(f.geometry[0]), L.aeroway.extent);
        push({ id: idOf('aero', f, i), layer: 'aeroway', name: cap(cls), rings, lon: c[0], lat: c[1], glyph: '✈', color: t.dim, size: 0, fillOnly: true, fillPattern: 2, info: info([['Type', cap(cls)], ['Ref', f.props.ref]]) });
      }
    });
  }
  if (on('aeroway') && L.aerodrome_label) {
    L.aerodrome_label.features.forEach((f, i) => {
      if (f.type !== 1) return;
      const { name, local } = displayName(f.props);
      const [lon, lat] = toLL(f.geometry[0], L.aerodrome_label.extent);
      push({ id: idOf('aerodrome', f, i), layer: 'aeroway', name: name || 'Aerodrome', lon, lat, glyph: '✈', color: t.accent3, size: f.props.class === 'international' ? 2 : 1, info: info([['Type', cap(f.props.class)], ['IATA', f.props.iata], ['ICAO', f.props.icao], ['Elevation', f.props.ele && `${f.props.ele} m`], ['Local name', local]]) });
    });
  }
  if (on('boundaries') && zoomLod >= 4 && L.boundary) {
    L.boundary.features.forEach((f, i) => {
      if (f.type !== 2) return;
      const lvl = Number(f.props.admin_level) || 2;
      if (lvl > 4 && zoomLod < 10) return;
      if (lvl > 6 && zoomLod < 13) return;
      if (f.props.maritime && zoomLod < 8) return;
      for (const line of f.geometry) {
        const pts = ringLL(line, L.boundary.extent);
        push({ id: idOf('bnd', f, i), layer: 'boundaries', name: `${lvl <= 2 ? 'Country' : lvl <= 4 ? 'Region' : lvl <= 6 ? 'District' : 'Local'} boundary${f.props.disputed ? ' (disputed)' : ''}`, points: pts, lon: pts[0][0], lat: pts[0][1], glyph: '╌', color: f.props.disputed ? t.warn : lvl <= 2 ? t.dim : t.muted, size: 0, dash: lvl <= 2 ? 4 : 2, info: info([['Admin level', lvl], ['Disputed', f.props.disputed ? 'yes' : ''], ['Maritime', f.props.maritime ? 'yes' : '']]) });
      }
    });
  }
  if (on('places') && L.place) {
    L.place.features.forEach((f, i) => {
      if (f.type !== 1) return;
      const cls = f.props.class;
      const st = PLACE[cls];
      if (!st || zoomLod < st.minZ) return;
      if (cls === 'city' && zoomLod < 6 && (f.props.rank || 10) > 6) return;
      const { name, local } = displayName(f.props);
      if (!name) return;
      const [lon, lat] = toLL(f.geometry[0], L.place.extent);
      push({ id: idOf('place', f, i), layer: 'places', name, lon, lat, glyph: cls === 'city' ? '●' : cls === 'town' ? '○' : '·', color: t[st.key] || t.text, size: st.size, labelAlways: true, upper: st.upper, info: info([['Type', cap(cls)], ['Local name', local], ['Capital', f.props.capital ? `admin level ${f.props.capital}` : ''], ['Rank', f.props.rank]]) });
    });
  }
  if (on('streetNames') && zoomLod >= 13 && L.transportation_name) {
    L.transportation_name.features.forEach((f, i) => {
      if (f.type !== 2) return;
      const cls = f.props.class;
      const base = ROADS[cls];
      const { name, local } = displayName(f.props);
      const text = name || f.props.ref;
      if (!text) return;
      if (base && zoomLod < Math.max(13, base.minZ + 1)) return;
      const line = f.geometry.reduce((a, b) => (b.length > a.length ? b : a), f.geometry[0]);
      const mid = line[Math.floor(line.length / 2)];
      const [lon, lat] = toLL(mid, L.transportation_name.extent);
      push({ id: idOf('sname', f, i), layer: 'streetNames', name: text, lon, lat, glyph: '', color: t.dim, size: base ? Math.min(2, base.weight) : 0, labelOnly: true, info: info([['Road class', base ? base.label : cap(cls)], ['Ref', f.props.ref], ['Local name', local]]) });
    });
  }
  if ((on('pois') || on('worship')) && zoomLod >= 11 && L.poi) {
    L.poi.features.forEach((f, i) => {
      if (f.type !== 1) return;
      const st = poiStyle(f.props, t);
      if (!on(st.layer)) return;
      if (zoomLod < st.minZ) return;
      const { name, local } = displayName(f.props);
      if (!name && zoomLod < 16 && st.layer !== 'worship') return; // unnamed shops wait for z16; places of worship always show
      const [lon, lat] = toLL(f.geometry[0], L.poi.extent);
      push({ id: idOf('poi', f, i), layer: st.layer, name: name || st.kind, lon, lat, glyph: st.glyph, color: st.color, size: st.layer === 'worship' ? 2 : zoomLod >= 16 ? 1 : st.minZ <= 12 ? 2 : 1, bold: st.bold, kind: st.kind, osmId: f.id, info: info([['Type', st.kind], ['Category', `${f.props.class}${f.props.subclass && f.props.subclass !== f.props.class ? ` / ${f.props.subclass}` : ''}`], ['Local name', local], ['Level', f.props.level], ['OSM id', f.id]]) });
    });
  }
  if (on('housenumbers') && zoomLod >= 17 && L.housenumber) {
    L.housenumber.features.forEach((f, i) => {
      if (f.type !== 1 || !f.props.housenumber) return;
      const [lon, lat] = toLL(f.geometry[0], L.housenumber.extent);
      push({ id: idOf('hn', f, i), layer: 'housenumbers', name: String(f.props.housenumber), lon, lat, glyph: '', color: t.muted, size: 0, labelOnly: true, info: info([['House number', f.props.housenumber]]) });
    });
  }
  if (on('peaks') && zoomLod >= 9 && L.mountain_peak) {
    L.mountain_peak.features.forEach((f, i) => {
      if (f.type !== 1) return;
      const { name, local } = displayName(f.props);
      if (!name && zoomLod < 12) return;
      if ((f.props.rank || 1) > 1 && zoomLod < 11) return;
      const [lon, lat] = toLL(f.geometry[0], L.mountain_peak.extent);
      push({ id: idOf('peak', f, i), layer: 'peaks', name: name || cap(f.props.class || 'peak'), lon, lat, glyph: '▲', color: t.text, size: 1, info: info([['Type', cap(f.props.class || 'peak')], ['Elevation', f.props.ele && `${f.props.ele} m (${f.props.ele_ft} ft)`], ['Local name', local]]) });
    });
  }
  return out;
}

function mixish(t) {
  return t.dim;
}

// Links for a street-level feature (used by the detail overlay).
export function featureLinks(f) {
  const links = [];
  const q = encodeURIComponent(`${f.name || ''}`.trim());
  links.push({ label: 'OpenStreetMap', url: `https://www.openstreetmap.org/?mlat=${f.lat.toFixed(6)}&mlon=${f.lon.toFixed(6)}#map=18/${f.lat.toFixed(5)}/${f.lon.toFixed(5)}` });
  links.push({ label: 'Google Maps', url: `https://www.google.com/maps/search/?api=1&query=${f.lat.toFixed(6)}%2C${f.lon.toFixed(6)}` });
  if (q && !['buildings', 'roads', 'water', 'landuse', 'boundaries', 'housenumbers'].includes(f.layer)) {
    links.push({ label: 'Wikipedia search', url: `https://en.wikipedia.org/w/index.php?search=${q}` });
  }
  if (f.url) links.unshift({ label: 'Website', url: f.url });
  return links;
}
