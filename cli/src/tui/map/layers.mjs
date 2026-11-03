// Map layers: every geo dataset the dashboard has, turned into features the
// terminal map can draw, hover, highlight and expand. Static registries come
// from the catalog (snapshotted from the web app's config), live data from the
// store. Each layer builds plain features:
//
//   { id, layer, name, lat, lon, glyph, color, size,
//     points?: [[lon, lat]...]        polyline (cables, pipelines, routes, tracks)
//     rings?: [[[lon, lat]...]]       polygon (conflict zones, weather polygons)
//     from?, to?, info: [[label, value]...], url?, ts?, heading?, speedKt? }
import { ageOf, enumLabel, fmtInt, fmtNum } from '../data/select.mjs';
import { severityColor } from '../ui/theme.mjs';
import { countryCentroidByA2 } from './world.mjs';
import { parseTle, propagate } from './orbit.mjs';

export const LAYER_GROUPS = [
  { id: 'infra', label: 'Infrastructure' },
  { id: 'military', label: 'Military & nuclear' },
  { id: 'hazards', label: 'Hazards & weather' },
  { id: 'civil', label: 'Society & cyber' },
  { id: 'mobility', label: 'Ships & aircraft' },
  { id: 'economy', label: 'Economy & resources' },
  { id: 'tech', label: 'Tech' },
  { id: 'overlays', label: 'Overlays' },
];

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : NaN);
const loc = (e) => {
  const lat = num(e?.lat ?? e?.latitude ?? e?.location?.latitude ?? e?.location?.lat ?? e?.centroid?.latitude ?? e?.centroid?.lat);
  const lon = num(e?.lon ?? e?.lng ?? e?.longitude ?? e?.location?.longitude ?? e?.location?.lon ?? e?.centroid?.longitude ?? e?.centroid?.lon);
  if (Number.isFinite(lat) && Number.isFinite(lon)) return [lat, lon];
  if (Array.isArray(e?.centroid) && e.centroid.length === 2) {
    // GeoJSON order [lon, lat]
    const [a, b] = e.centroid.map(Number);
    if (Math.abs(a) <= 180 && Math.abs(b) <= 90) return [b, a];
  }
  return null;
};
const str = (v) => (v === undefined || v === null || v === '' ? '' : Array.isArray(v) ? v.join(', ') : String(v));
const info = (pairs) => pairs.filter(([, v]) => str(v) !== '' && str(v) !== '—' && str(v) !== 'undefined').map(([k, v]) => [k, str(v)]);
const when = (ts, now) => (ts ? `${ageOf(ts, now)} ago` : '');
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const lineEnds = (points) => (points && points.length ? { from: points[0], to: points[points.length - 1] } : {});

function baseColor(t, type) {
  const k = String(type || '').toLowerCase();
  if (/china|pla/.test(k)) return t.bad;
  if (/russia/.test(k)) return t.warn;
  if (/nato|allied|uk|france|eu/.test(k)) return t.info;
  if (/us|united/.test(k)) return t.accent;
  return t.text;
}

function pipelineColor(t, type) {
  return type === 'gas' ? t.accent3 : type === 'oil' ? t.warn : t.info;
}

function ciiColor(t, score) {
  if (!Number.isFinite(score)) return null;
  if (score >= 75) return t.bad;
  if (score >= 55) return t.warn;
  if (score >= 35) return t.accent3;
  return t.good;
}

// --- registry -----------------------------------------------------------------

export const LAYERS = [
  // Infrastructure
  {
    id: 'cables', group: 'infra', label: 'Undersea cables', glyph: '━', kind: 'line', on: true, color: 'accent',
    build: ({ catalog, t }) => (catalog.layers?.cables || []).map((c) => ({
      id: `cable:${c.id}`, name: c.name, points: c.points, lat: c.points[0][1], lon: c.points[0][0], glyph: '━', color: c.major ? t.accent : t.map, size: c.major ? 2 : 1,
      ...lineEnds(c.points), nodes: (c.landings || []).map((l) => ({ lat: l.lat, lon: l.lon, name: `${l.city || ''} ${l.country || ''}`.trim() })),
      fromName: c.landings?.[0] && `${c.landings[0].city || ''}, ${c.landings[0].country}`, toName: c.landings?.length > 1 && `${c.landings[c.landings.length - 1].city || ''}, ${c.landings[c.landings.length - 1].country}`,
      info: info([['Type', c.major ? 'major submarine cable' : 'submarine cable'], ['In service', c.rfsYear], ['Capacity', c.capacityTbps && `${c.capacityTbps} Tbps`], ['Owners', c.owners], ['Landings', (c.landings || []).map((l) => `${l.city ? `${l.city}, ` : ''}${l.country}`)]]),
    })),
  },
  {
    id: 'pipelines', group: 'infra', label: 'Pipelines', glyph: '─', kind: 'line', on: true, color: 'accent3',
    sources: ['pipelinesGas', 'pipelinesOil'],
    build: ({ catalog, data, t, now }) => {
      const live = { ...(data.pipelinesGas?.pipelines || {}), ...(data.pipelinesOil?.pipelines || {}) };
      return (catalog.layers?.pipelines || []).map((p) => {
        const l = live[p.id] || {};
        const state = l.evidence?.physicalState;
        return {
          id: `pipe:${p.id}`, name: p.name, points: p.points, lat: p.points[0][1], lon: p.points[0][0], glyph: '─', color: state === 'offline' ? t.bad : pipelineColor(t, p.type), size: p.status === 'operating' ? 2 : 1, dash: p.status === 'construction' ? 3 : 0,
          ...lineEnds(p.points), fromName: p.origin?.name || p.origin?.country, toName: p.destination?.name || p.destination?.country,
          info: info([['Type', `${p.type} pipeline`], ['Status', state ? `${state} (${l.evidence?.physicalStateSource || 'operator'})` : p.status], ['Capacity', p.capacity || (l.capacityBcmYr && `${l.capacityBcmYr} bcm/yr`)], ['Length', p.length || (l.lengthKm && `${fmtInt(l.lengthKm)} km`)], ['Operator', p.operator || l.operator], ['Countries', p.countries], ['In service', l.inService], ['Statement', l.evidence?.operatorStatement?.text], ['Updated', when(l.evidence?.lastUpdated || l.updatedAt, now)]]),
        };
      });
    },
  },
  {
    id: 'storage', group: 'infra', label: 'Energy storage', glyph: '▣', kind: 'point', on: false, color: 'accent3', sources: ['storageFacilities'],
    build: ({ data, t }) => Object.values(data.storageFacilities?.facilities || {}).map((f) => {
      const p = loc(f.location || f);
      if (!p) return null;
      return { id: `storage:${f.id}`, name: f.name, lat: p[0], lon: p[1], glyph: '▣', color: f.evidence?.physicalState === 'offline' ? t.bad : t.accent3, size: 1, info: info([['Type', f.facilityType], ['Operator', f.operator], ['Country', f.country], ['Capacity', f.capacityTwh && `${f.capacityTwh} ${f.workingCapacityUnit || 'TWh'}`], ['State', f.evidence?.physicalState], ['In service', f.inService]]) };
    }).filter(Boolean),
  },
  {
    id: 'energyDisruptions', group: 'infra', label: 'Energy disruptions', glyph: '↯', kind: 'point', on: true, color: 'bad', sources: ['energyDisruptions', 'storageFacilities'],
    build: ({ catalog, data, t, now }) => {
      const pipes = new Map((catalog.layers?.pipelines || []).map((p) => [p.id, p]));
      const stores = data.storageFacilities?.facilities || {};
      return Object.values(data.energyDisruptions?.events || {}).map((e) => {
        let p = null;
        const pipe = pipes.get(e.assetId);
        if (pipe) {
          const mid = pipe.points[Math.floor(pipe.points.length / 2)];
          p = [mid[1], mid[0]];
        } else if (stores[e.assetId]) p = loc(stores[e.assetId].location || stores[e.assetId]);
        if (!p) return null;
        const active = !e.endAt;
        return { id: `edis:${e.id}`, name: `${cap(e.eventType || 'disruption')}: ${pipe?.name || stores[e.assetId]?.name || e.assetId}`, lat: p[0], lon: p[1], glyph: '↯', color: active ? t.bad : t.warn, size: active ? 2 : 1, pulse: active, ts: Date.parse(e.startAt) || 0,
          info: info([['Asset', e.assetType], ['Started', e.startAt && e.startAt.slice(0, 10)], ['Ended', e.endAt ? e.endAt.slice(0, 10) : 'ongoing'], ['Capacity offline', e.capacityOfflineBcmYr ? `${e.capacityOfflineBcmYr} bcm/yr` : e.capacityOfflineMbd ? `${e.capacityOfflineMbd} mb/d` : ''], ['Cause', e.causeChain], ['Summary', e.shortDescription], ['Countries', e.countries], ['Confidence', e.classifierConfidence], ['Evidence updated', when(e.lastEvidenceUpdate, now)]]), url: e.sources?.[0]?.url };
      }).filter(Boolean);
    },
  },
  {
    id: 'datacenters', group: 'infra', label: 'AI data centers', glyph: '▪', kind: 'point', on: false, color: 'accent3',
    build: ({ catalog, t }) => (catalog.layers?.datacenters || []).map((d) => ({ id: `dc:${d.id}`, name: d.name, lat: d.lat, lon: d.lon, glyph: '▪', color: d.status === 'existing' ? t.accent3 : t.dim, size: d.chipCount >= 100000 ? 2 : 1, info: info([['Owner', d.owner], ['Country', d.country], ['Status', d.status], ['Chips', d.chipCount && `${fmtInt(d.chipCount)} × ${d.chipType || ''}`], ['Power', d.powerMW && `${fmtInt(d.powerMW)} MW`]]) })),
  },
  {
    id: 'cloudRegions', group: 'infra', label: 'Cloud regions', glyph: '☁', kind: 'point', on: false, color: 'info',
    build: ({ catalog, t }) => (catalog.layers?.cloudRegions || []).map((d) => ({ id: `cloud:${d.id}`, name: `${String(d.provider || '').toUpperCase()} ${d.name}`, lat: d.lat, lon: d.lon, glyph: '☁', color: t.info, size: 1, info: info([['Provider', d.provider], ['City', d.city], ['Country', d.country], ['Zones', d.zones]]) })),
  },
  {
    id: 'ports', group: 'infra', label: 'Ports', glyph: '♆', kind: 'point', on: true, color: 'info',
    build: ({ catalog, t }) => (catalog.layers?.ports || []).map((p) => ({ id: `port:${p.id}`, name: p.name, lat: p.lat, lon: p.lon, glyph: '♆', color: t.info, size: p.rank && p.rank <= 10 ? 2 : 1, info: info([['Country', p.country], ['Type', p.type], ['Rank', p.rank && `#${p.rank}`], ['Note', p.note]]) })),
  },
  {
    id: 'airports', group: 'infra', label: 'Airports & delays', glyph: '✈', kind: 'point', on: false, color: 'dim', sources: ['flightDelays'],
    build: ({ catalog, data, t, now }) => {
      const delays = new Map((data.flightDelays?.alerts || []).map((a) => [a.iata, a]));
      return (catalog.layers?.airports || []).map((a) => {
        const d = delays.get(a.iata);
        const sev = d ? enumLabel(d.severity) : '';
        return { id: `apt:${a.iata}`, name: `${a.iata} ${a.name}`, lat: a.lat, lon: a.lon, glyph: '✈', color: d ? severityColor(t, sev) : t.dim, size: d ? 2 : 0, pulse: Boolean(d) && /severe|major/i.test(sev), ts: d?.updatedAt,
          info: info([['City', `${a.city}, ${a.country}`], ['ICAO', a.icao], ['Region', a.region], ['Delay', d && enumLabel(d.delayType)], ['Severity', sev], ['Average delay', d?.avgDelayMinutes && `${d.avgDelayMinutes} min`], ['Delayed flights', d?.delayedFlightsPct && `${d.delayedFlightsPct}%`], ['Cancelled', d?.cancelledFlights], ['Reason', d?.reason], ['Source', d && enumLabel(d.source)], ['Updated', when(d?.updatedAt, now)]]) };
      });
    },
  },
  {
    id: 'waterways', group: 'infra', label: 'Chokepoints', glyph: '◆', kind: 'point', on: true, color: 'warn',
    build: ({ catalog, data, t }) => {
      const live = new Map((data.chokepoints?.chokepoints || []).map((c) => [c.id, c]));
      return (catalog.layers?.waterways || []).map((w) => {
        const c = live.get(w.id) || {};
        const status = c.status || 'unknown';
        const color = status === 'red' ? t.bad : status === 'yellow' ? t.warn : status === 'green' ? t.good : t.warn;
        const ts = c.transitSummary || {};
        return { id: `cp:${w.id}`, name: cap(w.name.toLowerCase()), lat: w.lat, lon: w.lon, glyph: '◆', color, size: 2, pulse: status === 'red',
          info: info([['Status', c.status && `${c.status} · disruption ${c.disruptionScore ?? '—'}/100`], ['Congestion', c.congestionLevel], ['Active warnings', c.activeWarnings], ['AIS disruptions', c.aisDisruptions], ['Transits today', ts.todayCountsAvailable ? `${ts.todayTotal} (${ts.todayTanker} tankers, ${ts.todayCargo} cargo)` : ''], ['Week over week', Number.isFinite(ts.wowChangePct) ? `${ts.wowChangePct > 0 ? '+' : ''}${ts.wowChangePct}%` : ''], ['Risk', ts.riskLevel], ['Incidents (7d)', ts.incidentCount7d], ['Routes', w.routes], ['About', c.description || w.description]]) };
      });
    },
  },
  {
    id: 'tradeRoutes', group: 'infra', label: 'Trade routes', glyph: '┈', kind: 'line', on: false, color: 'good',
    build: ({ catalog, t }) => (catalog.layers?.tradeRoutes || []).map((s) => ({ id: `route:${s.id}`, name: s.name, points: s.points, lat: s.points[0][1], lon: s.points[0][0], glyph: '┈', color: s.status === 'disrupted' ? t.bad : s.status === 'high_risk' ? t.warn : s.category === 'energy' ? t.accent3 : t.good, size: 1, dash: 4, flow: true, ...lineEnds(s.points), info: info([['Category', s.category], ['Status', s.status?.replace('_', ' ')], ['Volume', s.volume], ['Segment', s.segment]]) })),
  },
  {
    id: 'fuelShortages', group: 'infra', label: 'Fuel shortages', glyph: '◭', kind: 'point', on: false, color: 'warn',
    build: ({ data, world, t, now }) => Object.values(data.fuelShortages?.shortages || {}).map((s) => {
      const c = world && countryCentroidByA2(world, s.country);
      if (!c) return null;
      return { id: `fuel:${s.id}`, name: `${s.product} shortage · ${c.name}`, lat: c.lat, lon: c.lon, glyph: '◭', color: s.resolvedAt ? t.dim : s.severity === 'confirmed' ? t.bad : t.warn, size: s.resolvedAt ? 0 : 1, info: info([['Product', s.product], ['Severity', s.severity], ['Impact', s.impactTypes], ['Cause', s.causeChain], ['Summary', s.shortDescription], ['First seen', s.firstSeen?.slice(0, 10)], ['Last confirmed', s.lastConfirmed?.slice(0, 10)], ['Resolved', s.resolvedAt ? s.resolvedAt.slice(0, 10) : 'no'], ['Updated', when(s.lastConfirmed, now)]]), url: s.evidence?.evidenceSources?.[0]?.url };
    }).filter(Boolean),
  },

  // Military & nuclear
  {
    id: 'bases', group: 'military', label: 'Military bases', glyph: '▲', kind: 'point', on: true, color: 'text',
    build: ({ catalog, t }) => (catalog.layers?.bases || []).map((b) => ({ id: `base:${b.id}`, name: b.name, lat: b.lat, lon: b.lon, glyph: '▲', color: baseColor(t, b.type), size: 1, info: info([['Operator', b.type], ['Host country', b.country], ['Branch', b.arm], ['Status', b.status], ['About', b.description]]) })),
  },
  {
    id: 'nuclear', group: 'military', label: 'Nuclear sites', glyph: '☢', kind: 'point', on: true, color: 'warn',
    build: ({ catalog, t }) => (catalog.layers?.nuclear || []).map((n) => ({ id: `nuc:${n.id}`, name: n.name, lat: n.lat, lon: n.lon, glyph: '☢', color: n.status === 'contested' ? t.bad : n.status === 'construction' ? t.info : n.status === 'active' ? t.warn : t.dim, size: n.type === 'plant' ? 1 : 2, info: info([['Type', n.type], ['Status', n.status], ['Operator', n.operator], ['Since', n.since], ['IAEA', n.iaea]]) })),
  },
  {
    id: 'irradiators', group: 'military', label: 'Gamma irradiators', glyph: '☢', kind: 'point', on: false, color: 'dim',
    build: ({ catalog, t }) => (catalog.layers?.irradiators || []).map((n) => ({ id: `irr:${n.id}`, name: n.name, lat: n.lat, lon: n.lon, glyph: '☢', color: t.dim, size: 0, info: info([['City', n.city], ['Country', n.country]]) })),
  },
  {
    id: 'radiation', group: 'military', label: 'Radiation watch', glyph: '◉', kind: 'point', on: true, color: 'good',
    build: ({ data, t, now }) => (data.radiationWatch?.observations || []).map((o) => {
      const p = loc(o);
      if (!p) return null;
      const sev = enumLabel(o.severity);
      return { id: `rad:${o.id}`, name: `${o.locationName || o.country} · ${o.value} ${o.unit}`, lat: p[0], lon: p[1], glyph: '◉', color: /normal|low/i.test(sev) ? t.good : severityColor(t, sev), size: /normal|low/i.test(sev) ? 0 : 2, pulse: /spike|high|critical/i.test(sev), ts: o.observedAt, info: info([['Reading', `${o.value} ${o.unit}`], ['Baseline', o.baselineValue && `${o.baselineValue} ${o.unit} (Δ ${o.delta >= 0 ? '+' : ''}${o.delta}, z ${o.zScore})`], ['Severity', sev], ['Source', enumLabel(o.source)], ['Confidence', enumLabel(o.confidence)], ['Corroborated', o.corroborated ? 'yes' : 'no'], ['Observed', when(o.observedAt, now)]]) };
    }).filter(Boolean),
  },
  {
    id: 'spaceports', group: 'military', label: 'Spaceports', glyph: '✱', kind: 'point', on: true, color: 'accent2',
    build: ({ catalog, t }) => (catalog.layers?.spaceports || []).map((s) => ({ id: `space:${s.id}`, name: s.name, lat: s.lat, lon: s.lon, glyph: '✱', color: s.status === 'active' ? t.accent2 : t.dim, size: s.launches === 'High' ? 2 : 1, info: info([['Country', s.country], ['Operator', s.operator], ['Status', s.status], ['Launch cadence', s.launches]]) })),
  },
  {
    id: 'flights', group: 'mobility', label: 'Military aircraft', glyph: '✈', kind: 'point', on: true, color: 'accent', sources: ['flights'],
    build: ({ raw, t, now }) => (raw.flights?.flights || []).map((f) => {
      const p = loc(f);
      if (!p) return null;
      const kind = enumLabel(f.aircraftType);
      return { id: `ac:${f.id}`, name: `${f.callsign || f.hexCode || 'aircraft'}${f.aircraftModel ? ` · ${f.aircraftModel}` : ''}`, lat: p[0], lon: p[1], glyph: '✈', color: /fighter|bomber|reconnaissance|awacs|drone/.test(kind) ? t.accent2 : t.accent, size: 2, heading: f.heading, speedKt: f.speed, ts: f.lastSeenAt, moving: !f.onGround,
        info: info([['Operator', `${enumLabel(f.operator)} ${f.operatorCountry || ''}`.trim()], ['Type', kind !== 'unknown' ? kind : ''], ['Model', f.aircraftModel], ['Registration', f.registration], ['Altitude', f.altitude && `${fmtInt(f.altitude)} ft`], ['Speed', f.speed && `${fmtInt(f.speed)} kt`], ['Heading', Number.isFinite(f.heading) && `${Math.round(f.heading)}°`], ['Vertical rate', f.verticalRate && `${f.verticalRate} ft/min`], ['Squawk', f.squawk], ['Route', f.origin || f.destination ? `${f.origin || '?'} → ${f.destination || '?'}` : ''], ['Seen', when(f.lastSeenAt, now)]]) };
    }).filter(Boolean),
  },
  {
    id: 'satellites', group: 'mobility', label: 'Surveillance satellites', glyph: '✦', kind: 'point', on: true, color: 'accent3', sources: ['satellites'],
    build: ({ raw, t, now }) => (raw.satellites?.satellites || []).map((s) => {
      const tle = parseTle(s.line1, s.line2);
      if (!tle) return null;
      const p = propagate(tle, now);
      return { id: `sat:${s.id}`, name: s.name, lat: p.lat, lon: p.lon, glyph: '✦', color: t.accent3, size: 1, tle, info: info([['Country', s.country], ['Type', s.type], ['Altitude', `${fmtInt(p.altKm)} km`], ['Period', `${p.periodMin.toFixed(0)} min`], ['Inclination', `${tle.inclination.toFixed(1)}°`], ['NORAD', s.id]]) };
    }).filter(Boolean),
  },
  {
    id: 'hotspots', group: 'military', label: 'Intel hotspots', glyph: '◎', kind: 'point', on: true, color: 'accent2',
    build: ({ catalog, data, t, now }) => {
      const posture = new Map((data.theaterPosture?.theaters || []).map((p) => [String(p.theater || '').replace(/-theater$/, ''), p]));
      return (catalog.layers?.hotspots || []).map((h) => {
        const p = posture.get(h.id);
        const level = p?.postureLevel || h.level || 'low';
        return { id: `hot:${h.id}`, name: h.name, lat: h.lat, lon: h.lon, glyph: '◎', color: severityColor(t, level), size: 2, pulse: /elevated|high|critical/i.test(level), info: info([['Level', level], ['Focus', h.subtext], ['Location', h.location], ['Posture', p && `${p.activeFlights ?? 0} aircraft · ${p.trackedVessels ?? 0} vessels`], ['Operations', p?.activeOperations], ['Assessed', when(p?.assessedAt, now)], ['Agencies', h.agencies], ['About', h.description]]) };
      });
    },
  },
  {
    id: 'conflictZones', group: 'military', label: 'Conflict zones', glyph: '▧', kind: 'polygon', on: true, color: 'bad',
    build: ({ catalog, t }) => (catalog.layers?.conflictZones || []).map((z) => ({ id: `zone:${z.id}`, name: z.name, rings: [z.coords], lat: z.lat, lon: z.lon, glyph: '▧', color: z.intensity === 'high' ? t.bad : z.intensity === 'medium' ? t.warn : t.dim, size: 2, info: info([['Intensity', z.intensity], ['Parties', z.parties], ['Casualties', z.casualties], ['Displaced', z.displaced], ['Since', z.startDate], ['About', z.description]]) })),
  },
  {
    id: 'ucdp', group: 'military', label: 'Armed conflict events', glyph: '✕', kind: 'point', on: true, color: 'bad',
    build: ({ data, t, now }) => (data.ucdpEvents?.events || []).map((e) => {
      const p = loc(e);
      if (!p) return null;
      const deaths = e.deathsBest || 0;
      return { id: `ucdp:${e.id}`, name: `${e.sideA || '?'} vs ${e.sideB || '?'}`, lat: p[0], lon: p[1], glyph: '✕', color: t.bad, size: deaths >= 25 ? 2 : deaths >= 5 ? 1 : 0, ts: e.dateStart, info: info([['Country', e.country], ['Type', enumLabel(e.violenceType)], ['Deaths', `${deaths} (${e.deathsLow ?? '?'}–${e.deathsHigh ?? '?'})`], ['Date', e.dateStart && new Date(e.dateStart).toISOString().slice(0, 10)], ['Source', e.sourceOriginal], ['Age', when(e.dateStart, now)]]) };
    }).filter(Boolean),
  },

  // Hazards & weather
  {
    id: 'earthquakes', group: 'hazards', label: 'Earthquakes', glyph: '●', kind: 'point', on: true, color: 'warn',
    build: ({ data, t, now }) => (data.earthquakes?.earthquakes || []).map((e) => {
      const p = loc(e);
      if (!p) return null;
      const m = e.magnitude || 0;
      return { id: `eq:${e.id}`, name: `M${m.toFixed(1)} ${e.place || ''}`, lat: p[0], lon: p[1], glyph: m >= 6 ? '◉' : '●', color: m >= 6 ? t.bad : m >= 5 ? t.warn : t.dim, size: m >= 6 ? 3 : m >= 5 ? 2 : 1, ts: e.occurredAt, ring: m >= 5 && now - e.occurredAt < 6 * 3600e3, info: info([['Magnitude', m.toFixed(1)], ['Depth', e.depthKm && `${fmtNum(e.depthKm, 0)} km`], ['When', when(e.occurredAt, now)], ['Source', e.source]]), url: e.sourceUrl };
    }).filter(Boolean),
  },
  {
    id: 'fires', group: 'hazards', label: 'Fires & thermal anomalies', glyph: '*', kind: 'point', on: true, color: 'warn',
    build: ({ data, t, now }) => {
      const out = [];
      for (const c of data.thermalEscalation?.clusters || []) {
        const p = loc(c);
        if (!p) continue;
        out.push({ id: `thermal:${c.id}`, name: `Thermal cluster · ${c.regionLabel || c.countryName}`, lat: p[0], lon: p[1], glyph: '✸', color: c.frpDelta > 0 ? t.bad : t.warn, size: 2, pulse: c.frpDelta > 500, ts: Date.parse(c.lastDetectedAt), info: info([['Detections', `${c.observationCount} from ${c.uniqueSourceCount} sources`], ['Max brightness', c.maxBrightness && `${c.maxBrightness} K`], ['Fire power', `${fmtNum(c.totalFrp, 0)} MW (Δ ${c.frpDelta >= 0 ? '+' : ''}${fmtNum(c.frpDelta, 0)} vs baseline)`], ['Night share', Number.isFinite(c.nightDetectionShare) && `${Math.round(c.nightDetectionShare * 100)}%`], ['First seen', when(Date.parse(c.firstDetectedAt), now)], ['Last seen', when(Date.parse(c.lastDetectedAt), now)]]) });
      }
      const fires = [...(data.wildfires?.fireDetections || [])].sort((a, b) => (b.frp || 0) - (a.frp || 0)).slice(0, 400);
      for (const f of fires) {
        const p = loc(f);
        if (!p) continue;
        out.push({ id: `fire:${f.id}`, name: `Fire · ${f.region || 'unknown region'}`, lat: p[0], lon: p[1], glyph: '*', color: f.possibleExplosion ? t.bad : t.warn, size: f.frp >= 100 ? 1 : 0, ts: f.detectedAt, info: info([['Fire power', f.frp && `${fmtNum(f.frp, 0)} MW`], ['Brightness', f.brightness && `${f.brightness} K`], ['Confidence', enumLabel(f.confidence)], ['Satellite', f.satellite], ['Day/night', f.dayNight === 'D' ? 'day' : 'night'], ['Possible explosion', f.possibleExplosion ? 'yes' : ''], ['Detected', when(f.detectedAt, now)], ['Source', f.source]]) });
      }
      return out;
    },
  },
  {
    id: 'natural', group: 'hazards', label: 'Storms & natural events', glyph: '◍', kind: 'point', on: true, color: 'info',
    build: ({ data, t, now }) => (data.naturalEvents?.events || []).map((e) => {
      const p = loc(e);
      if (!p) return null;
      return { id: `nat:${e.id}`, name: e.title, lat: p[0], lon: p[1], glyph: /storm|cyclone|hurricane|typhoon/i.test(e.categoryTitle || e.category) ? '๑' : '◍', color: e.closed ? t.dim : t.info, size: e.closed ? 0 : 2, pulse: !e.closed && /storm|cyclone|hurricane|typhoon/i.test(e.categoryTitle || e.category), ts: e.date, info: info([['Category', e.categoryTitle || e.category], ['Magnitude', e.magnitude && `${e.magnitude} ${e.magnitudeUnit || ''}`], ['Basin', e.basin], ['Status', e.closed ? 'closed' : 'active'], ['Source', e.sourceName], ['Updated', when(e.date, now)], ['About', e.description]]), url: e.sourceUrl };
    }).filter(Boolean),
  },
  {
    id: 'disasters', group: 'hazards', label: 'Disaster alerts (GDACS)', glyph: '◈', kind: 'point', on: true, color: 'warn',
    build: ({ data, t, now }) => (data.climateDisasters?.disasters || []).map((d) => {
      const p = loc(d);
      if (!p) return null;
      return { id: `gdacs:${d.id}`, name: d.name, lat: p[0], lon: p[1], glyph: '◈', color: d.severity === 'red' ? t.bad : d.severity === 'orange' ? t.warn : t.good, size: d.severity === 'red' ? 3 : 2, ts: d.startedAt, pulse: d.severity === 'red' && d.status !== 'past', info: info([['Type', d.type], ['Country', d.country], ['Severity', d.severity], ['Status', d.status], ['Affected population', d.affectedPopulation && fmtInt(d.affectedPopulation)], ['Started', when(d.startedAt, now)], ['Source', d.source]]), url: d.sourceUrl };
    }).filter(Boolean),
  },
  {
    id: 'weather', group: 'hazards', label: 'Severe weather alerts', glyph: '⚠', kind: 'polygon', on: true, color: 'warn',
    build: ({ data, world, t }) => (data.weatherAlerts?.alerts || []).map((a, i) => {
      let p = loc(a);
      if (!p && a.countryCode && world) {
        const c = countryCentroidByA2(world, a.countryCode);
        if (c) p = [c.lat, c.lon];
      }
      const rings = Array.isArray(a.coordinates) && a.coordinates.length >= 3 ? [a.coordinates] : null;
      if (!p && rings) {
        const r = rings[0];
        p = [r.reduce((s, q) => s + q[1], 0) / r.length, r.reduce((s, q) => s + q[0], 0) / r.length];
      }
      if (!p) return null;
      const sev = a.severity || 'Unknown';
      return { id: `wx:${a.id || i}`, name: a.event || a.headline, rings, lat: p[0], lon: p[1], glyph: '⚠', color: severityColor(t, sev), size: /extreme|severe/i.test(sev) ? 2 : 1, ts: Date.parse(a.onset || a.sent || ''), pulse: /extreme/i.test(sev), info: info([['Severity', `${sev}${a.urgency ? ` · ${a.urgency}` : ''}${a.certainty ? ` · ${a.certainty}` : ''}`], ['Area', a.areaDesc], ['Headline', a.headline], ['Onset', a.onset], ['Expires', a.expires], ['Authority', a.authority || a.source], ['Precision', a.geometryPrecision === 'country' ? 'country-level geocode' : rings ? 'warned-area polygon' : ''], ['Details', a.description && a.description.slice(0, 400)]]) };
    }).filter(Boolean),
  },
  {
    id: 'canadaAlerts', group: 'hazards', label: 'Canada emergency alerts', glyph: '⚠', kind: 'point', on: true, color: 'bad',
    build: ({ data, t, now }) => (data.canadaAlerts?.alerts || []).map((a) => {
      const p = loc(a);
      if (!p) return null;
      return { id: `ca:${a.id}`, name: `${a.province}: ${a.headline || a.event}`, lat: p[0], lon: p[1], glyph: '⚠', color: severityColor(t, a.severity), size: 2, ts: a.updatedAt, info: info([['Event', a.event], ['Severity', a.severity], ['Area', a.areaDesc], ['Onset', a.onset], ['Expires', a.expires], ['Source', a.source], ['Updated', when(a.updatedAt, now)], ['Details', a.description && a.description.slice(0, 400)]]), url: a.url };
    }).filter(Boolean),
  },
  {
    id: 'canadaRoads', group: 'hazards', label: 'Canada road incidents', glyph: '▬', kind: 'point', on: false, color: 'warn', sources: ['canadaRoads'],
    build: ({ data, t }) => (data.canadaRoads?.records || []).map((r) => {
      const p = loc(r);
      if (!p) return null;
      const line = Array.isArray(r.path) && r.path.length > 1 ? r.path.map((q) => (Array.isArray(q) ? q : [q.lon ?? q.lng, q.lat])) : null;
      return { id: `road:${r.id}`, name: `${r.roadwayName || r.headline || 'road'}: ${r.eventType || r.kind}`, lat: p[0], lon: p[1], points: line, glyph: '▬', color: r.isFullClosure ? t.bad : severityColor(t, r.severity), size: r.isFullClosure ? 2 : 0, info: info([['Jurisdiction', r.jurisdiction], ['Type', r.eventType], ['Severity', r.severity], ['Closure', r.isFullClosure ? 'full closure' : r.lanesAffected], ['Headline', r.headline], ['Details', r.description && r.description.slice(0, 300)], ['Source', r.source]]) };
    }).filter(Boolean),
  },
  {
    id: 'climate', group: 'hazards', label: 'Climate anomalies', glyph: '≈', kind: 'point', on: false, color: 'info',
    build: ({ data, t }) => (data.climateAnomalies?.anomalies || []).map((a, i) => {
      const p = loc(a);
      if (!p) return null;
      const warm = /WARM|HEAT/.test(a.type || '');
      return { id: `clim:${a.zone || i}`, name: `${a.zone}: ${a.tempDelta > 0 ? '+' : ''}${a.tempDelta}°C`, lat: p[0], lon: p[1], glyph: '≈', color: warm ? t.bad : t.info, size: /EXTREME|SEVERE/.test(a.severity || '') ? 2 : 0, info: info([['Temperature', `${a.tempDelta > 0 ? '+' : ''}${a.tempDelta}°C vs normal`], ['Precipitation', Number.isFinite(a.precipDelta) && `${a.precipDelta > 0 ? '+' : ''}${a.precipDelta}`], ['Type', enumLabel(a.type)], ['Severity', enumLabel(a.severity)], ['Period', a.period]]) };
    }).filter(Boolean),
  },
  {
    id: 'disease', group: 'hazards', label: 'Disease outbreaks', glyph: '✚', kind: 'point', on: true, color: 'accent2',
    build: ({ data, t, now }) => (data.diseaseOutbreaks?.outbreaks || []).map((o) => {
      const p = loc(o);
      if (!p) return null;
      return { id: `dis:${o.id}`, name: `${o.disease} · ${o.location || o.countryCode}`, lat: p[0], lon: p[1], glyph: '✚', color: /emergency|high/i.test(o.alertLevel) ? t.bad : /alert|elevated/i.test(o.alertLevel) ? t.accent2 : t.dim, size: /emergency/i.test(o.alertLevel) ? 2 : 1, ts: o.publishedAt, info: info([['Disease', o.disease], ['Alert level', o.alertLevel], ['Cases', o.cases && fmtInt(o.cases)], ['Deaths', o.deaths && fmtInt(o.deaths)], ['Summary', o.summary && o.summary.slice(0, 300)], ['Source', o.sourceName], ['Published', when(o.publishedAt, now)]]), url: o.sourceUrl };
    }).filter(Boolean),
  },

  // Society & cyber
  {
    id: 'unrest', group: 'civil', label: 'Protests & unrest', glyph: '▲', kind: 'point', on: true, color: 'accent2',
    build: ({ data, t, now }) => (data.unrestEvents?.events || []).map((e) => {
      const p = loc(e);
      if (!p) return null;
      return { id: `unrest:${e.id}`, name: e.title, lat: p[0], lon: p[1], glyph: '▲', color: t.accent2, size: (e.fatalities || 0) > 0 ? 2 : 1, ts: e.occurredAt, info: info([['Place', [e.city, e.region, e.country].filter(Boolean).join(', ')], ['Type', enumLabel(e.eventType)], ['Severity', enumLabel(e.severity)], ['Fatalities', e.fatalities], ['Confidence', enumLabel(e.confidence)], ['Source', enumLabel(e.sourceType)], ['Summary', e.summary && e.summary.slice(0, 300)], ['When', when(e.occurredAt, now)]]), url: e.sources?.[0]?.url || e.sources?.[0] };
    }).filter(Boolean),
  },
  {
    id: 'outages', group: 'civil', label: 'Internet outages', glyph: '◌', kind: 'point', on: true, color: 'dim',
    build: ({ data, t, now }) => (data.outages?.outages || []).map((o) => {
      const p = loc(o);
      if (!p) return null;
      const active = !o.endedAt;
      return { id: `out:${o.id}`, name: o.title, lat: p[0], lon: p[1], glyph: '◌', color: active ? t.bad : t.dim, size: active ? 2 : 1, pulse: active, ts: o.detectedAt, info: info([['Country', [o.region, o.country].filter(Boolean).join(', ')], ['Severity', enumLabel(o.severity)], ['Scope', enumLabel(o.outageType)], ['Cause', enumLabel(o.cause)], ['Detected', when(o.detectedAt, now)], ['Ended', o.endedAt ? when(o.endedAt, now) : 'ongoing'], ['About', o.description && o.description.slice(0, 300)]]), url: o.link };
    }).filter(Boolean),
  },
  {
    id: 'bgp', group: 'civil', label: 'BGP / traffic anomalies', glyph: '⊘', kind: 'point', on: false, color: 'muted',
    build: ({ data, t, now }) => (data.trafficAnomalies?.anomalies || []).map((a) => {
      const p = loc(a);
      if (!p) return null;
      return { id: `bgp:${a.uuid}`, name: `${a.asnName || a.asn} ${a.type || ''} anomaly`, lat: p[0], lon: p[1], glyph: '⊘', color: t.dim, size: 0, ts: a.startDate, info: info([['ASN', a.asn], ['Network', a.asnName], ['Status', a.status], ['Location', a.locationName || a.locationCode], ['Started', when(a.startDate, now)]]) };
    }).filter(Boolean),
  },
  {
    id: 'cyber', group: 'civil', label: 'Cyber threat infrastructure', glyph: '¤', kind: 'point', on: false, color: 'accent3', sources: ['cyberThreats'],
    build: ({ data, t, now }) => (data.cyberThreats?.threats || []).slice(0, 600).map((c) => {
      const p = loc(c);
      if (!p) return null;
      return { id: `cyber:${c.id}`, name: `${enumLabel(c.type)}${c.malwareFamily ? ` · ${c.malwareFamily}` : ''}`, lat: p[0], lon: p[1], glyph: '¤', color: /CRITICAL|HIGH/.test(c.severity || '') ? t.accent2 : t.accent3, size: /CRITICAL/.test(c.severity || '') ? 1 : 0, ts: c.firstSeenAt, info: info([['Indicator', `${c.indicator} (${enumLabel(c.indicatorType)})`], ['Country', c.country], ['Severity', enumLabel(c.severity)], ['Malware', c.malwareFamily], ['Tags', c.tags], ['Source', enumLabel(c.source)], ['First seen', when(c.firstSeenAt, now)]]) };
    }).filter(Boolean),
  },
  {
    id: 'positive', group: 'civil', label: 'Positive events', glyph: '✿', kind: 'point', on: false, color: 'good',
    build: ({ data, t, now }) => (data.positiveGeoEvents?.events || []).map((e, i) => {
      const p = loc(e);
      if (!p) return null;
      return { id: `pos:${e.name}:${i}`, name: `${e.name}: ${e.count} ${String(e.category || '').replace(/-/g, ' ')}`, lat: p[0], lon: p[1], glyph: '✿', color: t.good, size: e.count >= 50 ? 2 : 1, ts: e.timestamp, info: info([['Category', String(e.category || '').replace(/-/g, ' ')], ['Count', e.count], ['Updated', when(e.timestamp, now)]]) };
    }).filter(Boolean),
  },

  // Ships & aircraft
  {
    id: 'shipping', group: 'mobility', label: 'Ship traffic density', glyph: '≋', kind: 'point', on: true, color: 'info', sources: ['vessels'],
    build: ({ raw, t, now }) => {
      const snap = raw.vessels?.snapshot || {};
      const out = [];
      for (const z of snap.densityZones || []) {
        const p = loc(z);
        if (!p) continue;
        const intensity = Number(z.intensity) || 0;
        out.push({ id: `dens:${z.id}`, name: `${z.name || 'traffic zone'} · ${fmtInt(z.shipsPerDay)} ships/day`, lat: p[0], lon: p[1], glyph: '≋', color: intensity >= 0.8 ? t.info : intensity >= 0.4 ? t.map : t.mapDim, size: intensity >= 0.8 ? 2 : intensity >= 0.4 ? 1 : 0, info: info([['Ships per day', fmtInt(z.shipsPerDay)], ['Intensity', `${Math.round(intensity * 100)}%`], ['Change', Number.isFinite(z.deltaPct) && `${z.deltaPct > 0 ? '+' : ''}${z.deltaPct}%`], ['Note', z.note], ['Snapshot', when(snap.snapshotAt, now)]]) });
      }
      for (const r of snap.tankerReports || []) {
        const p = loc(r);
        if (!p) continue;
        out.push({ id: `tanker:${r.id || r.mmsi}`, name: r.name || `Tanker ${r.mmsi || ''}`, lat: p[0], lon: p[1], glyph: '⊳', color: t.warn, size: 2, heading: r.heading ?? r.cog, speedKt: r.speed ?? r.sog, moving: true, info: info([['MMSI', r.mmsi], ['Flag', r.flag], ['Destination', r.destination], ['Speed', r.speed ?? r.sog], ['Reported', when(r.reportedAt || r.timestamp, now)]]) });
      }
      return out;
    },
  },
  {
    id: 'aisDisruptions', group: 'mobility', label: 'AIS disruptions', glyph: '⚠', kind: 'point', on: true, color: 'warn', sources: ['vessels'],
    build: ({ raw, t }) => (raw.vessels?.snapshot?.disruptions || []).map((d) => {
      const p = loc(d);
      if (!p) return null;
      const sev = enumLabel(d.severity);
      return { id: `ais:${d.id}`, name: `${d.name}: ${enumLabel(d.type).replace(/_/g, ' ')}`, lat: p[0], lon: p[1], glyph: '⚠', color: severityColor(t, sev), size: 2, pulse: /high/i.test(sev), info: info([['Type', enumLabel(d.type)], ['Severity', sev], ['Change', Number.isFinite(d.changePct) && `${d.changePct > 0 ? '+' : ''}${d.changePct}% over ${d.windowHours}h`], ['Vessels', d.vesselCount], ['Dark ships', d.darkShips], ['Region', d.region], ['About', d.description]]) };
    }).filter(Boolean),
  },

  // Economy & resources
  {
    id: 'economic', group: 'economy', label: 'Economic centers', glyph: '$', kind: 'point', on: false, color: 'good',
    build: ({ catalog, t }) => (catalog.layers?.economicCenters || []).map((e) => ({ id: `econ:${e.id}`, name: e.name, lat: e.lat, lon: e.lon, glyph: '$', color: t.good, size: 1, info: info([['Type', e.type], ['Country', e.country], ['Hours', e.hours], ['About', e.description]]) })),
  },
  {
    id: 'exchanges', group: 'economy', label: 'Stock exchanges', glyph: '◆', kind: 'point', on: false, color: 'good',
    build: ({ catalog, t }) => (catalog.layers?.stockExchanges || []).map((e) => ({ id: `xch:${e.id}`, name: e.shortName || e.name, lat: e.lat, lon: e.lon, glyph: '◆', color: t.good, size: e.tier === 'mega' ? 2 : 1, info: info([['Exchange', e.name], ['City', `${e.city}, ${e.country}`], ['Tier', e.tier], ['Market cap', e.marketCapT && `$${e.marketCapT}T`], ['Hours', e.hours], ['About', e.description]]) })),
  },
  {
    id: 'financialCenters', group: 'economy', label: 'Financial centers', glyph: '◇', kind: 'point', on: false, color: 'good',
    build: ({ catalog, t }) => (catalog.layers?.financialCenters || []).map((e) => ({ id: `fin:${e.id}`, name: e.name, lat: e.lat, lon: e.lon, glyph: '◇', color: t.good, size: 1, info: info([['Country', e.country], ['Type', e.type], ['GFCI rank', e.gfciRank && `#${e.gfciRank}`], ['Specialties', e.specialties], ['About', e.description]]) })),
  },
  {
    id: 'centralBanks', group: 'economy', label: 'Central banks', glyph: '⌂', kind: 'point', on: false, color: 'warn',
    build: ({ catalog, t }) => (catalog.layers?.centralBanks || []).map((e) => ({ id: `cb:${e.id}`, name: e.name, lat: e.lat, lon: e.lon, glyph: '⌂', color: t.warn, size: 1, info: info([['City', `${e.city}, ${e.country}`], ['Currency', e.currency], ['About', e.description]]) })),
  },
  {
    id: 'commodityHubs', group: 'economy', label: 'Commodity hubs', glyph: '◈', kind: 'point', on: false, color: 'warn',
    build: ({ catalog, t }) => (catalog.layers?.commodityHubs || []).map((e) => ({ id: `chub:${e.id}`, name: e.name, lat: e.lat, lon: e.lon, glyph: '◈', color: t.warn, size: 1, info: info([['City', `${e.city}, ${e.country}`], ['Type', e.type], ['Commodities', e.commodities], ['About', e.description]]) })),
  },
  {
    id: 'gulfInvestments', group: 'economy', label: 'Gulf investments', glyph: '◆', kind: 'point', on: false, color: 'accent3',
    build: ({ catalog, t }) => (catalog.layers?.gulfInvestments || []).map((e) => ({ id: `gulf:${e.id}`, name: e.name, lat: e.lat, lon: e.lon, glyph: '◆', color: t.accent3, size: e.usd >= 5e9 ? 2 : 1, info: info([['Investor', `${e.investor} (${e.from})`], ['Country', e.country], ['Sector', e.sector], ['Asset', e.assetType], ['Value', e.usd && `$${fmtNum(e.usd, 1)}`], ['Announced', e.year], ['Status', e.status]]) })),
  },
  {
    id: 'mining', group: 'economy', label: 'Mines & minerals', glyph: '▼', kind: 'point', on: false, color: 'warn',
    build: ({ catalog, t }) => [
      ...(catalog.layers?.miningSites || []).map((e) => ({ id: `mine:${e.id}`, name: `${e.name} (${e.mineral})`, lat: e.lat, lon: e.lon, glyph: '▼', color: e.status === 'producing' ? t.warn : t.dim, size: 1, info: info([['Mineral', e.mineral], ['Country', e.country], ['Operator', e.operator], ['Status', e.status], ['Why it matters', e.significance]]) })),
      ...(catalog.layers?.criticalMinerals || []).map((e) => ({ id: `cmin:${e.id}`, name: `${e.name} (${e.mineral})`, lat: e.lat, lon: e.lon, glyph: '▼', color: t.accent3, size: 2, info: info([['Mineral', e.mineral], ['Country', e.country], ['Operator', e.operator], ['Status', e.status], ['Why it matters', e.significance]]) })),
      ...(catalog.layers?.processingPlants || []).map((e) => ({ id: `plant:${e.id}`, name: e.name, lat: e.lat, lon: e.lon, glyph: '▣', color: t.warn, size: 1, info: info([['Type', `${e.type} · ${e.mineral}`], ['Country', e.country], ['Operator', e.operator], ['Status', e.status], ['Why it matters', e.significance]]) })),
      ...(catalog.layers?.commodityPorts || []).map((e) => ({ id: `cport:${e.id}`, name: e.name, lat: e.lat, lon: e.lon, glyph: '♆', color: t.warn, size: 1, info: info([['Country', e.country], ['Commodities', e.commodities], ['Throughput', e.throughput], ['Why it matters', e.significance]]) })),
      ...(catalog.layers?.commodityMiners || []).map((e) => ({ id: `miner:${e.id}`, name: e.name, lat: e.lat, lon: e.lon, glyph: '▿', color: t.dim, size: 0, info: info([['Site', e.siteType], ['Sector', e.sector], ['Minerals', e.minerals], ['Country', e.country], ['Ticker', e.symbol], ['Status', e.status]]) })),
    ],
  },

  // Tech
  {
    id: 'techHQs', group: 'tech', label: 'Tech HQs', glyph: '▪', kind: 'point', on: false, color: 'accent',
    build: ({ catalog, t }) => [
      ...(catalog.layers?.techHQs || []).map((e) => ({ id: `hq:${e.id}`, name: e.name, lat: e.lat, lon: e.lon, glyph: '▪', color: t.accent, size: e.type === 'faang' ? 2 : 1, info: info([['City', `${e.city}, ${e.country}`], ['Type', e.type], ['Market cap', e.marketCap]]) })),
      ...(catalog.layers?.techCompanies || []).map((e) => ({ id: `co:${e.id}`, name: e.name, lat: e.lat, lon: e.lon, glyph: '▫', color: t.accent, size: 0, info: info([['Sector', e.sector], ['Office', e.office], ['City', `${e.city}, ${e.country}`], ['Employees', e.employees && fmtInt(e.employees)], ['Founded', e.founded], ['Products', e.products]]) })),
    ],
  },
  {
    id: 'aiLabs', group: 'tech', label: 'AI research labs', glyph: '✪', kind: 'point', on: false, color: 'accent3',
    build: ({ catalog, t }) => (catalog.layers?.aiLabs || []).map((e) => ({ id: `lab:${e.id}`, name: e.name, lat: e.lat, lon: e.lon, glyph: '✪', color: t.accent3, size: 1, info: info([['Type', e.type], ['City', `${e.city}, ${e.country}`], ['Founded', e.founded], ['Focus', e.focus]]) })),
  },
  {
    id: 'startups', group: 'tech', label: 'Startup hubs & accelerators', glyph: '✦', kind: 'point', on: false, color: 'accent2',
    build: ({ catalog, t }) => [
      ...(catalog.layers?.startupHubs || []).map((e) => ({ id: `hub:${e.id}`, name: e.name, lat: e.lat, lon: e.lon, glyph: '✦', color: t.accent2, size: e.tier === 'mega' ? 2 : 1, info: info([['City', `${e.city}, ${e.country}`], ['Tier', e.tier], ['Unicorns', e.unicorns]]) })),
      ...(catalog.layers?.startupEcosystems || []).map((e) => ({ id: `eco:${e.id}`, name: e.name, lat: e.lat, lon: e.lon, glyph: '✧', color: t.accent2, size: 0, info: info([['City', `${e.city}, ${e.country}`], ['Tier', e.tier], ['Active startups', e.startups && fmtInt(e.startups)], ['Unicorns', e.unicorns], ['Sectors', e.sectors]]) })),
      ...(catalog.layers?.accelerators || []).map((e) => ({ id: `acc:${e.id}`, name: e.name, lat: e.lat, lon: e.lon, glyph: '✧', color: t.dim, size: 0, info: info([['City', `${e.city}, ${e.country}`], ['Type', e.type], ['Founded', e.founded], ['Notable', e.notable]]) })),
    ],
  },

  // Overlays
  { id: 'cii', group: 'overlays', label: 'Country instability (CII)', glyph: '▒', kind: 'choropleth', on: false, color: 'bad',
    countryColor: ({ data, t }) => {
      const scores = new Map();
      const list = data.riskScores?.ciiScores;
      for (const s of Array.isArray(list) ? list : Object.values(list || {})) if (s?.region) scores.set(String(s.region).toUpperCase(), s);
      return (country) => {
        const s = country.a2 && scores.get(country.a2);
        return s ? ciiColor(t, s.combinedScore) : null;
      };
    },
    countryInfo: ({ data }) => {
      const list = data.riskScores?.ciiScores;
      const scores = new Map();
      for (const s of Array.isArray(list) ? list : Object.values(list || {})) if (s?.region) scores.set(String(s.region).toUpperCase(), s);
      return (country) => {
        const s = country.a2 && scores.get(country.a2);
        return s ? info([['CII score', `${s.combinedScore}/100 (${enumLabel(s.trend)})`], ['Static baseline', s.staticBaseline], ['Advisory', s.advisoryLevel], ['News activity', s.components?.newsActivity], ['Military activity', s.components?.militaryActivity], ['Computed', ageOf(s.computedAt)]]) : null;
      };
    },
  },
  { id: 'sanctions', group: 'overlays', label: 'Sanctioned countries', glyph: '▒', kind: 'choropleth', on: false, color: 'accent2',
    countryColor: ({ catalog, t }) => (country) => {
      const lvl = country.a2 && catalog.layers?.sanctions?.[country.a2];
      return lvl === 'severe' ? t.bad : lvl === 'high' ? t.accent2 : lvl === 'moderate' ? t.warn : null;
    },
    countryInfo: ({ catalog, data }) => (country) => {
      const lvl = country.a2 && catalog.layers?.sanctions?.[country.a2];
      const p = (data.sanctionsPressure?.countries || []).find((c) => c.countryCode === country.a2);
      return lvl || p ? info([['Sanctions', lvl && `${lvl} regime`], ['OFAC/consolidated entries', p?.entryCount && fmtInt(p.entryCount)], ['New entries', p?.newEntryCount], ['Vessels listed', p?.vesselCount], ['Aircraft listed', p?.aircraftCount]]) : null;
    },
  },
  { id: 'dayNight', group: 'overlays', label: 'Day / night terminator', glyph: '☾', kind: 'overlay', on: true, color: 'dim' },
  { id: 'graticule', group: 'overlays', label: 'Graticule', glyph: '┼', kind: 'overlay', on: true, color: 'muted' },
  { id: 'labels', group: 'overlays', label: 'Country names', glyph: 'A', kind: 'overlay', on: true, color: 'dim' },
  { id: 'borders', group: 'overlays', label: 'Borders & coastlines', glyph: '╱', kind: 'overlay', on: true, color: 'map' },
];

export const LAYER_BY_ID = new Map(LAYERS.map((l) => [l.id, l]));

export function defaultLayerState() {
  return Object.fromEntries(LAYERS.map((l) => [l.id, Boolean(l.on)]));
}

// Store sources (lazy or not) a set of enabled layers depends on.
export function layerSources(enabled) {
  const out = new Set();
  for (const l of LAYERS) if (enabled[l.id]) for (const s of l.sources || []) out.add(s);
  return [...out];
}

// Build all features for the enabled layers. Returns { features, byLayer }.
export function buildFeatures(ctx, enabled) {
  const features = [];
  const counts = {};
  for (const l of LAYERS) {
    if (!enabled[l.id] || !l.build) continue;
    let list = [];
    try {
      list = l.build(ctx) || [];
    } catch {
      list = [];
    }
    counts[l.id] = list.length;
    for (const f of list) {
      if (!f) continue;
      f.layer = l.id;
      f.layerLabel = l.label;
      if (!Number.isFinite(f.lat) || !Number.isFinite(f.lon)) continue;
      features.push(f);
    }
  }
  return { features, counts };
}
