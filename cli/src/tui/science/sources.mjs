// The Phenomena source registry: every keyless feed the view tracks, grouped
// by what it is (detectors, space, earth, preprints, journals, labs, press,
// declassified, integrity, prizes, ai). Each entry fetches one URL on its own
// cadence and turns the body into events (and, for live instruments, a signal
// series for the oscilloscope and the correlation engine). Verified 2026-10-21.
import { parseDate, stripTags } from './feeds.mjs';

const MIN = 60000;
const H = 60 * MIN;

export const GROUPS = {
  detectors: { label: 'Detectors', glyph: '◉', hint: 'neutrinos, gravitational waves, transients' },
  space: { label: 'Space weather & objects', glyph: '☀', hint: 'flares, geomagnetic storms, fireballs, asteroids' },
  earth: { label: 'Earth', glyph: '◍', hint: 'seismic, volcanic, tsunami, carbon' },
  preprints: { label: 'Preprints', glyph: '§', hint: 'arXiv, bioRxiv, medRxiv, INSPIRE, OSF, Zenodo' },
  journals: { label: 'Journals', glyph: '¶', hint: 'Nature, Science, PRL, Cell, PNAS, Lancet, NEJM' },
  labs: { label: 'Labs & agencies', glyph: '⌬', hint: 'CERN, Fermilab, NASA, ESO, MIT, NIST, DARPA' },
  press: { label: 'Science press', glyph: '▤', hint: 'Quanta, Phys.org, New Scientist, SciAm, BBC' },
  declassified: { label: 'Declassified & FOIA', glyph: '▣', hint: 'NTRS, OSTI, Black Vault, DARPA' },
  integrity: { label: 'Integrity', glyph: '⚠', hint: 'retractions and corrections' },
  prizes: { label: 'Prizes', glyph: '✶', hint: 'Nobel prizes' },
  ai: { label: 'AI & computing', glyph: '⌘', hint: 'daily papers, lab blogs' },
  bio: { label: 'Biology & medicine', glyph: '⚕', hint: 'trials, preprints, outbreaks' },
};

// --- helpers ------------------------------------------------------------------------

function feedEvents(feed, { kind = 'news', limit = 40, intensity = null } = {}) {
  return (feed.items || []).slice(0, limit).map((it) => ({ title: it.title, summary: it.summary.slice(0, 600), url: it.link, at: it.at, kind, intensity, author: it.author }));
}

// A plain RSS / Atom source.
function rss(id, label, group, url, { every = 2 * H, kind = 'news', limit = 40, home = null, maxBytes } = {}) {
  return { id, label, group, url, home, kind: 'feed', every, maxBytes, parse: (feed) => ({ events: feedEvents(feed, { kind, limit }) }) };
}

function arxiv(cat, label) {
  return {
    id: `arxiv-${cat.replace(/\W/g, '')}`,
    label: `arXiv ${label}`,
    group: 'preprints',
    url: `https://export.arxiv.org/api/query?search_query=cat:${cat}&sortBy=submittedDate&sortOrder=descending&max_results=25`,
    home: `https://arxiv.org/list/${cat}/new`,
    kind: 'feed',
    every: 3 * H,
    parse: (feed) => ({ events: feedEvents(feed, { kind: 'paper', limit: 25 }).map((e) => ({ ...e, tags: [cat] })) }),
  };
}

function biorxiv(server, group) {
  return {
    id: server,
    label: server === 'biorxiv' ? 'bioRxiv' : 'medRxiv',
    group,
    url: null, // built per call: the API wants an explicit date window
    home: `https://www.${server}.org`,
    kind: 'json',
    every: 4 * H,
    urlFor: (now) => {
      const d = (ms) => new Date(ms).toISOString().slice(0, 10);
      return `https://api.biorxiv.org/details/${server}/${d(now - 3 * 86400000)}/${d(now)}/0/json`;
    },
    parse: (json) => ({
      events: (json.collection || []).slice(0, 60).map((p) => ({
        title: p.title,
        summary: String(p.abstract || '').slice(0, 600),
        url: p.doi ? `https://doi.org/${p.doi}` : '',
        at: parseDate(p.date),
        kind: 'paper',
        author: p.authors,
        tags: [p.category].filter(Boolean),
      })),
    }),
  };
}

// JPL close-approach dates look like '2026-Oct-21 23:47'.
export function cadDate(s) {
  const m = /^(\d{4})-([A-Za-z]{3})-(\d{2}) (\d{2}):(\d{2})/.exec(String(s || ''));
  if (!m) return 0;
  const mo = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2].toLowerCase());
  return mo < 0 ? 0 : Date.UTC(Number(m[1]), mo, Number(m[3]), Number(m[4]), Number(m[5]));
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// --- the registry -------------------------------------------------------------------

export const SOURCES = [
  // Detectors: the instruments that see the universe before anyone writes it up.
  {
    id: 'icecube',
    label: 'IceCube gold/bronze alerts',
    group: 'detectors',
    url: 'https://gcn.gsfc.nasa.gov/amon_icecube_gold_bronze_events.html',
    home: 'https://gcn.gsfc.nasa.gov/amon_icecube_gold_bronze_events.html',
    kind: 'text',
    every: 30 * MIN,
    parse: (html) => {
      const events = [];
      const seen = new Set();
      const rowRe = /<tr[^>]*>\s*<td><a href=([^>\s]+)>([^<]+)<\/a><\/td>([\s\S]*?)<\/tr>/g;
      let m;
      while ((m = rowRe.exec(html)) && events.length < 40) {
        const id = m[2].trim();
        if (seen.has(id)) continue; // revisions repeat the event; the first row is the newest revision
        seen.add(id);
        const cells = [...m[3].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => stripTags(c[1]));
        const [rev, date, time, type, ra, dec, err90, , energy, signalness, far] = cells;
        const [yy, mo, dd] = String(date || '').split('/');
        const at = parseDate(`20${yy}-${mo}-${dd}T${String(time || '').slice(0, 8)}Z`);
        const tev = num(energy);
        const sig = num(signalness);
        events.push({
          title: `IceCube ${String(type || '').toLowerCase()} neutrino ${id}: ${tev ? `${tev.toFixed(0)} TeV` : ''} from RA ${ra}° Dec ${dec}°`.replace(/\s+/g, ' '),
          summary: `Astrophysical track candidate, revision ${rev}. Energy ${energy} TeV, signalness ${signalness}, false alarm rate ${far} per year, 90% error radius ${err90}′.`,
          url: `https://gcn.gsfc.nasa.gov/${m[1]}`,
          at,
          kind: 'alert',
          intensity: Math.min(1, (sig || 0.3) * (type === 'GOLD' ? 1 : 0.7)),
          tags: ['neutrino', String(type || '').toLowerCase()],
          ra: num(ra),
          dec: num(dec),
          lat: -89.99,
          lon: -63.45,
        });
      }
      return { events };
    },
  },
  {
    id: 'gracedb',
    label: 'LIGO/Virgo/KAGRA superevents',
    group: 'detectors',
    url: 'https://gracedb.ligo.org/api/superevents/?format=json&count=30&query=Production',
    home: 'https://gracedb.ligo.org/superevents/public/',
    kind: 'json',
    every: 30 * MIN,
    parse: (json) => ({
      events: (json.superevents || [])
        .filter((s) => s.category === 'Production' || /^S\d/.test(String(s.superevent_id || '')))
        .slice(0, 30)
        .map((s) => {
          const far = num(s.far);
          const perYear = far ? far * 3.15576e7 : null;
          return {
            title: `Gravitational-wave candidate ${s.superevent_id}${s.gw_id ? ` (${s.gw_id})` : ''}${perYear !== null ? (perYear < 1 ? `, one false alarm per ${Math.round(1 / perYear)} years` : `, ${perYear.toFixed(1)} false alarms per year`) : ''}`,
            summary: `Pipeline ${s.preferred_event_data?.pipeline || '?'} (${s.preferred_event_data?.group || '?'}). Labels: ${(s.labels || []).join(', ') || 'none'}.`,
            url: `https://gracedb.ligo.org/superevents/${s.superevent_id}/view/`,
            at: parseDate(String(s.created || '').replace(' UTC', 'Z').replace(' ', 'T')),
            kind: 'alert',
            intensity: perYear === null ? 0.4 : Math.max(0.1, Math.min(1, 0.5 - Math.log10(perYear) / 10)),
            tags: ['gravitational-wave', ...(s.labels || []).map((l) => String(l).toLowerCase())],
          };
        }),
    }),
  },
  { ...rss('atel', "Astronomer's Telegram", 'detectors', 'https://www.astronomerstelegram.org/?rss', { every: H, kind: 'alert', limit: 30 }), home: 'https://www.astronomerstelegram.org' },
  rss('tsunami', 'NOAA tsunami bulletins', 'earth', 'https://www.tsunami.gov/events/xml/PAAQAtom.xml', { every: 15 * MIN, kind: 'alert', limit: 10, home: 'https://www.tsunami.gov' }),

  // Space weather and near-Earth objects.
  {
    id: 'swpc-kp',
    label: 'NOAA planetary K-index',
    group: 'space',
    url: 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json',
    home: 'https://www.swpc.noaa.gov/products/planetary-k-index',
    kind: 'json',
    every: 10 * MIN,
    parse: (rows) => {
      const pts = (rows || []).map((r) => [parseDate(`${r.time_tag}Z`), num(r.estimated_kp)]).filter((p) => p[0] && p[1] !== null);
      const last = pts[pts.length - 1];
      const peak = pts.reduce((a, p) => Math.max(a, p[1]), 0);
      const events = [];
      if (peak >= 5) events.push({ title: `Geomagnetic storm: planetary K-index reached ${peak.toFixed(1)}`, summary: 'Kp 5 is a G1 minor storm, 7 is G3 strong, 9 is G5 extreme. Aurora reaches lower latitudes and satellites feel extra drag.', url: 'https://www.swpc.noaa.gov/products/planetary-k-index', at: pts.find((p) => p[1] >= 5)?.[0] || last[0], kind: 'measurement', intensity: Math.min(1, peak / 9), tags: ['geomagnetic'] });
      return { events, signal: { id: 'kp', label: 'Kp', unit: '', points: pts, min: 0, max: 9, warn: 5, current: last ? last[1] : null } };
    },
  },
  {
    id: 'swpc-xray',
    label: 'GOES X-ray flux',
    group: 'space',
    url: 'https://services.swpc.noaa.gov/json/goes/primary/xrays-6-hour.json',
    home: 'https://www.swpc.noaa.gov/products/goes-x-ray-flux',
    kind: 'json',
    every: 10 * MIN,
    parse: (rows) => {
      const pts = (rows || []).filter((r) => r.energy === '0.1-0.8nm').map((r) => [parseDate(r.time_tag), num(r.flux)]).filter((p) => p[0] && p[1] !== null && p[1] > 0);
      const last = pts[pts.length - 1];
      return { events: [], signal: { id: 'xray', label: 'X-ray', unit: 'W/m²', points: pts, log: true, min: 1e-9, max: 1e-3, warn: 1e-5, current: last ? last[1] : null } };
    },
  },
  {
    id: 'swpc-flares',
    label: 'GOES solar flares',
    group: 'space',
    url: 'https://services.swpc.noaa.gov/json/goes/primary/xray-flares-7-day.json',
    home: 'https://www.swpc.noaa.gov/products/goes-x-ray-flux',
    kind: 'json',
    every: 30 * MIN,
    parse: (rows) => ({
      events: (rows || [])
        .filter((r) => /^[MX]/.test(String(r.max_class || '')))
        .slice(-30)
        .reverse()
        .map((r) => {
          const cls = String(r.max_class);
          const mag = cls[0] === 'X' ? 10 * (num(cls.slice(1)) || 1) : num(cls.slice(1)) || 1;
          return { title: `${cls} solar flare peaked at ${String(r.max_time).replace('T', ' ').slice(0, 16)} UTC`, summary: `Began ${r.begin_time} as ${r.begin_class}, peaked ${r.max_time}, ended ${r.end_time || 'n/a'}. X-class flares are the strongest: radio blackouts on the day side and possible coronal mass ejections.`, url: 'https://www.swpc.noaa.gov/products/goes-x-ray-flux', at: parseDate(r.max_time), kind: 'event', intensity: Math.min(1, Math.log10(mag * 10) / 2.5), tags: ['solar-flare', cls[0].toLowerCase()] };
        }),
    }),
  },
  {
    id: 'swpc-protons',
    label: 'GOES proton flux',
    group: 'space',
    url: 'https://services.swpc.noaa.gov/json/goes/primary/integral-protons-1-day.json',
    home: 'https://www.swpc.noaa.gov/products/goes-proton-flux',
    kind: 'json',
    every: 15 * MIN,
    parse: (rows) => {
      const pts = (rows || []).filter((r) => r.energy === '>=10 MeV').map((r) => [parseDate(r.time_tag), num(r.flux)]).filter((p) => p[0] && p[1] !== null && p[1] > 0);
      const last = pts[pts.length - 1];
      const events = [];
      const peak = pts.reduce((a, p) => Math.max(a, p[1]), 0);
      if (peak >= 10) events.push({ title: `Solar radiation storm: proton flux ≥10 MeV reached ${peak.toFixed(0)} pfu`, summary: '10 pfu is an S1 minor radiation storm; 10,000 pfu is S4 severe. Astronauts and polar flights take notice.', url: 'https://www.swpc.noaa.gov/products/goes-proton-flux', at: pts.find((p) => p[1] >= 10)?.[0] || last[0], kind: 'measurement', intensity: Math.min(1, Math.log10(peak) / 5), tags: ['radiation-storm'] });
      return { events, signal: { id: 'protons', label: 'p+ ≥10 MeV', unit: 'pfu', points: pts, log: true, min: 0.1, max: 1e4, warn: 10, current: last ? last[1] : null } };
    },
  },
  {
    id: 'swpc-alerts',
    label: 'NOAA space weather alerts',
    group: 'space',
    url: 'https://services.swpc.noaa.gov/products/alerts.json',
    home: 'https://www.swpc.noaa.gov/products/alerts-watches-and-warnings',
    kind: 'json',
    every: 15 * MIN,
    parse: (rows) => ({
      events: (rows || []).slice(0, 25).map((r) => {
        const msg = String(r.message || '');
        const head = (msg.split('\n').find((l) => /^(WARNING|ALERT|WATCH|SUMMARY|EXTENDED WARNING|CANCEL)/i.test(l.trim())) || msg.split('\n')[0] || '').trim();
        return { title: head.replace(/\s+/g, ' ').slice(0, 140), summary: msg.replace(/\r/g, '').slice(0, 700), url: 'https://www.swpc.noaa.gov/products/alerts-watches-and-warnings', at: parseDate(`${String(r.issue_datetime).replace(' ', 'T')}Z`), kind: 'alert', intensity: /K-index of ([5-9])/.test(head) ? Number(RegExp.$1) / 9 : /X-ray|Proton/i.test(head) ? 0.5 : 0.2, tags: ['space-weather'] };
      }),
    }),
  },
  {
    id: 'swpc-f107',
    label: 'Solar radio flux 10.7 cm',
    group: 'space',
    url: 'https://services.swpc.noaa.gov/products/summary/10cm-flux.json',
    home: 'https://www.swpc.noaa.gov/phenomena/f107-cm-radio-emissions',
    kind: 'json',
    every: 3 * H,
    parse: (rows) => {
      const r = Array.isArray(rows) ? rows[0] : rows;
      const v = r ? num(r.flux) : null;
      return { events: [], signal: { id: 'f107', label: 'F10.7', unit: 'sfu', points: v !== null ? [[parseDate(`${r.time_tag}Z`), v]] : [], min: 60, max: 300, warn: 200, current: v } };
    },
  },
  {
    id: 'cneos-fireballs',
    label: 'NASA fireballs',
    group: 'space',
    url: 'https://ssd-api.jpl.nasa.gov/fireball.api?limit=30',
    home: 'https://cneos.jpl.nasa.gov/fireballs/',
    kind: 'json',
    every: 6 * H,
    parse: (json) => {
      const f = json.fields || [];
      const ix = (k) => f.indexOf(k);
      return {
        events: (json.data || []).map((row) => {
          const g = (k) => row[ix(k)];
          const kt = num(g('impact-e')) || 0;
          const lat = num(g('lat'));
          const lon = num(g('lon'));
          return { title: `Fireball over ${lat !== null ? `${lat}°${g('lat-dir')} ${lon}°${g('lon-dir')}` : 'unknown position'}: ${kt} kt impact energy`, summary: `Radiated energy ${g('energy')}×10¹⁰ J, altitude ${g('alt') || '?'} km, velocity ${g('vel') || '?'} km/s. Detected by US government sensors.`, url: 'https://cneos.jpl.nasa.gov/fireballs/', at: parseDate(`${String(g('date')).replace(' ', 'T')}Z`), kind: 'event', intensity: Math.min(1, Math.log10(1 + kt * 10) / 3), lat: lat !== null ? lat * (g('lat-dir') === 'S' ? -1 : 1) : null, lon: lon !== null ? lon * (g('lon-dir') === 'W' ? -1 : 1) : null, tags: ['fireball', 'bolide'] };
        }),
      };
    },
  },
  {
    id: 'cneos-cad',
    label: 'Asteroid close approaches',
    group: 'space',
    url: 'https://ssd-api.jpl.nasa.gov/cad.api?dist-max=0.05&date-min=now&date-max=%2B30&sort=date',
    home: 'https://cneos.jpl.nasa.gov/ca/',
    kind: 'json',
    every: 12 * H,
    parse: (json) => {
      const f = json.fields || [];
      const ix = (k) => f.indexOf(k);
      return {
        events: (json.data || []).slice(0, 40).map((row) => {
          const g = (k) => row[ix(k)];
          const au = num(g('dist')) || 0;
          const ld = au / 0.002569;
          const h = num(g('h'));
          const size = h !== null ? Math.round(1329 / Math.sqrt(0.14) * 10 ** (-h / 5) * 1000) : null;
          return { title: `${g('des')} passes ${ld.toFixed(1)} lunar distances on ${g('cd')}`, summary: `Nominal miss distance ${au.toFixed(5)} au, relative velocity ${num(g('v_rel'))?.toFixed(1)} km/s, absolute magnitude H ${h}${size ? ` (~${size} m across for an average albedo)` : ''}.`, url: `https://ssd.jpl.nasa.gov/tools/sbdb_lookup.html#/?sstr=${encodeURIComponent(String(g('des')))}`, at: cadDate(g('cd')), kind: 'event', intensity: Math.max(0.05, Math.min(1, (1 - ld / 20) * (size ? Math.min(1, size / 100) : 0.3))), tags: ['asteroid', 'close-approach'] };
        }),
      };
    },
  },
  {
    id: 'cneos-sentry',
    label: 'Sentry impact risk table',
    group: 'space',
    url: 'https://ssd-api.jpl.nasa.gov/sentry.api?ps-min=-3',
    home: 'https://cneos.jpl.nasa.gov/sentry/',
    kind: 'json',
    every: 24 * H,
    parse: (json, { now }) => ({
      events: (json.data || []).slice(0, 20).map((r) => ({ title: `${r.fullname}: impact probability ${(Number(r.ip) * 100).toPrecision(2)}% (${r.range}), Palermo ${r.ps_cum}`, summary: `Diameter ~${(Number(r.diameter) * 1000).toFixed(0)} m, ${r.n_imp} potential impacts, Torino ${r.ts_max}, last observed ${r.last_obs}. Palermo scale above 0 means more likely than the background risk.`, url: `https://cneos.jpl.nasa.gov/sentry/details.html#?des=${encodeURIComponent(String(r.des))}`, at: now, kind: 'document', intensity: Math.min(1, Math.max(0.05, (Number(r.ps_cum) + 4) / 4)), tags: ['asteroid', 'impact-risk'] })),
    }),
  },

  // Earth.
  {
    id: 'usgs-quakes',
    label: 'USGS earthquakes M4.5+',
    group: 'earth',
    url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson',
    home: 'https://earthquake.usgs.gov/earthquakes/map/',
    kind: 'json',
    every: 15 * MIN,
    parse: (json, { now }) => {
      const feats = json.features || [];
      const bins = new Map();
      for (const f of feats) {
        const t = f.properties?.time;
        if (!t) continue;
        const hour = Math.floor(t / H) * H;
        bins.set(hour, (bins.get(hour) || 0) + 1);
      }
      const pts = [];
      for (let h = Math.floor((now - 7 * 24 * H) / H) * H; h <= now; h += H) pts.push([h, bins.get(h) || 0]);
      return {
        events: feats.filter((f) => (f.properties?.mag || 0) >= 5.5).slice(0, 40).map((f) => ({ title: `M${Number(f.properties.mag).toFixed(1)} earthquake, ${f.properties.place}`, summary: `Depth ${f.geometry?.coordinates?.[2]} km. ${f.properties.tsunami ? 'Tsunami flag raised. ' : ''}${f.properties.felt ? `${f.properties.felt} felt reports. ` : ''}Alert level ${f.properties.alert || 'none'}.`, url: f.properties.url, at: f.properties.time, kind: 'event', intensity: Math.min(1, (f.properties.mag - 4.5) / 4.5), lat: f.geometry?.coordinates?.[1], lon: f.geometry?.coordinates?.[0], tags: ['earthquake'] })),
        signal: { id: 'quakes', label: 'M4.5+/h', unit: '/h', points: pts, min: 0, max: 8, warn: 5, current: pts.length ? pts[pts.length - 1][1] : null },
      };
    },
  },
  {
    id: 'usgs-geomag',
    label: 'USGS magnetometer (Boulder)',
    group: 'earth',
    url: 'https://geomag.usgs.gov/ws/data/?id=BOU&format=json&elements=H&sampling_period=60',
    home: 'https://geomag.usgs.gov/plots/',
    kind: 'json',
    every: 20 * MIN,
    parse: (json) => {
      const times = json.times || [];
      const vals = json.values?.[0]?.values || [];
      const pts = [];
      for (let i = 0; i < times.length; i++) if (vals[i] !== null && Number.isFinite(vals[i])) pts.push([parseDate(times[i]), vals[i]]);
      const mean = pts.length ? pts.reduce((a, p) => a + p[1], 0) / pts.length : 0;
      const dev = pts.map((p) => [p[0], p[1] - mean]);
      const last = dev[dev.length - 1];
      return { events: [], signal: { id: 'geomag', label: 'ΔH Boulder', unit: 'nT', points: dev, min: -300, max: 300, warn: 100, current: last ? last[1] : null } };
    },
  },
  {
    id: 'usgs-volcanoes',
    label: 'USGS elevated volcanoes',
    group: 'earth',
    url: 'https://volcanoes.usgs.gov/hans-public/api/volcano/getElevatedVolcanoes',
    home: 'https://www.usgs.gov/programs/VHP',
    kind: 'json',
    every: H,
    parse: (rows) => ({
      events: (rows || []).slice(0, 30).map((r) => ({ title: `${r.volcano_name}: ${String(r.color_code || '').toLowerCase()} / ${String(r.alert_level || '').toLowerCase()}`, summary: `${r.obs_fullname}. Notice ${r.notice_identifier}.`, url: String(r.notice_url || '').replace(/\\\//g, '/'), at: parseDate(`${String(r.sent_utc).replace(' ', 'T')}Z`), kind: 'alert', intensity: r.color_code === 'RED' ? 1 : r.color_code === 'ORANGE' ? 0.6 : 0.3, lat: num(r.latitude), lon: num(r.longitude), tags: ['volcano'] })),
    }),
  },
  {
    id: 'noaa-co2',
    label: 'Mauna Loa CO₂ (weekly)',
    group: 'earth',
    url: 'https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_weekly_mlo.csv',
    home: 'https://gml.noaa.gov/ccgg/trends/weekly.html',
    kind: 'text',
    every: 24 * H,
    parse: (text) => {
      const pts = [];
      for (const line of text.split('\n')) {
        if (!line || line[0] === '#') continue;
        const [y, m, d, , avg] = line.split(',');
        const v = num(avg);
        if (v !== null && v > 0) pts.push([Date.UTC(Number(y), Number(m) - 1, Number(d)), v]);
      }
      const tail = pts.slice(-104);
      const last = tail[tail.length - 1];
      return { events: [], signal: { id: 'co2', label: 'CO₂', unit: 'ppm', points: tail, min: 400, max: 460, warn: 430, current: last ? last[1] : null } };
    },
  },

  // Preprints.
  arxiv('hep-ex', 'high-energy experiment'),
  arxiv('hep-ph', 'high-energy phenomenology'),
  arxiv('hep-th', 'high-energy theory'),
  arxiv('gr-qc', 'gravitation & cosmology'),
  arxiv('astro-ph.HE', 'high-energy astrophysics'),
  arxiv('astro-ph.CO', 'cosmology'),
  arxiv('quant-ph', 'quantum physics'),
  arxiv('cond-mat.supr-con', 'superconductivity'),
  arxiv('cond-mat.mtrl-sci', 'materials'),
  arxiv('physics.plasm-ph', 'plasma & fusion'),
  arxiv('nucl-ex', 'nuclear experiment'),
  arxiv('q-bio.NC', 'neuroscience'),
  { ...arxiv('cs.AI', 'artificial intelligence'), group: 'ai' },
  biorxiv('biorxiv', 'bio'),
  biorxiv('medrxiv', 'bio'),
  {
    id: 'inspire',
    label: 'INSPIRE-HEP latest',
    group: 'preprints',
    url: 'https://inspirehep.net/api/literature?sort=mostrecent&size=25&q=arxiv_eprints.value:*&fields=titles,abstracts,arxiv_eprints,authors.full_name,earliest_date,citation_count,control_number',
    home: 'https://inspirehep.net',
    kind: 'json',
    every: 3 * H,
    parse: (json) => ({
      events: (json.hits?.hits || []).map((h) => {
        const md = h.metadata || {};
        const ep = md.arxiv_eprints?.[0]?.value;
        return { title: md.titles?.[0]?.title || '', summary: String(md.abstracts?.[0]?.value || '').slice(0, 600), url: ep ? `https://arxiv.org/abs/${ep}` : `https://inspirehep.net/literature/${md.control_number || h.id}`, at: parseDate(md.earliest_date), kind: 'paper', author: (md.authors || []).slice(0, 3).map((a) => a.full_name).join(', '), tags: ['hep'] };
      }),
    }),
  },
  {
    id: 'osf',
    label: 'OSF preprints',
    group: 'preprints',
    url: 'https://api.osf.io/v2/preprints/?page[size]=25&sort=-date_created',
    home: 'https://osf.io/preprints',
    kind: 'json',
    every: 6 * H,
    parse: (json) => ({ events: (json.data || []).map((p) => ({ title: p.attributes?.title || '', summary: stripTags(p.attributes?.description || '').slice(0, 600), url: p.links?.html || '', at: parseDate(p.attributes?.date_created), kind: 'paper', tags: (p.attributes?.tags || []).slice(0, 5) })) }),
  },
  {
    id: 'zenodo',
    label: 'Zenodo physics records',
    group: 'preprints',
    url: 'https://zenodo.org/api/records?sort=mostrecent&size=20&q=physics%20OR%20quantum%20OR%20neutrino',
    home: 'https://zenodo.org',
    kind: 'json',
    every: 6 * H,
    parse: (json) => ({ events: (json.hits?.hits || []).map((h) => ({ title: h.metadata?.title || h.title || '', summary: stripTags(h.metadata?.description || '').slice(0, 600), url: h.links?.self_html || h.doi_url || '', at: parseDate(h.created), kind: 'document', author: (h.metadata?.creators || []).slice(0, 3).map((c) => c.name).join(', '), tags: [h.metadata?.resource_type?.type].filter(Boolean) })) }),
  },
  {
    id: 'europepmc',
    label: 'Europe PMC (most cited this month)',
    group: 'bio',
    url: null,
    home: 'https://europepmc.org',
    kind: 'json',
    every: 12 * H,
    urlFor: (now) => {
      const d = (ms) => new Date(ms).toISOString().slice(0, 10);
      return `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=FIRST_PDATE:[${d(now - 30 * 86400000)}%20TO%20${d(now)}]%20AND%20(SRC:MED%20OR%20SRC:PPR)&format=json&pageSize=25&sort=CITED%20desc`;
    },
    parse: (json) => ({ events: (json.resultList?.result || []).map((r) => ({ title: r.title || '', summary: String(r.abstractText || '').slice(0, 600), url: r.doi ? `https://doi.org/${r.doi}` : r.pmid ? `https://europepmc.org/abstract/MED/${r.pmid}` : '', at: parseDate(r.firstPublicationDate), kind: 'paper', author: r.authorString, tags: ['cited'] })) }),
  },
  {
    id: 'clinicaltrials',
    label: 'ClinicalTrials.gov newest',
    group: 'bio',
    url: 'https://clinicaltrials.gov/api/v2/studies?pageSize=25&sort=StudyFirstPostDate:desc&filter.overallStatus=RECRUITING,NOT_YET_RECRUITING&query.term=gene%20OR%20CRISPR%20OR%20mRNA%20OR%20longevity%20OR%20brain-computer',
    home: 'https://clinicaltrials.gov',
    kind: 'json',
    every: 12 * H,
    parse: (json) => ({ events: (json.studies || []).map((s) => { const p = s.protocolSection || {}; return { title: p.identificationModule?.briefTitle || '', summary: String(p.descriptionModule?.briefSummary || '').slice(0, 600), url: `https://clinicaltrials.gov/study/${p.identificationModule?.nctId}`, at: parseDate(p.statusModule?.studyFirstPostDateStruct?.date), kind: 'document', tags: ['trial'] }; }) }),
  },
  {
    id: 'exoplanets',
    label: 'NASA Exoplanet Archive',
    group: 'space',
    url: 'https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=select+top+25+pl_name,hostname,disc_year,pl_rade,pl_bmasse,sy_dist,disc_facility,disc_pubdate,pl_orbper,pl_eqt+from+pscomppars+where+disc_pubdate+is+not+null+order+by+disc_pubdate+desc&format=json',
    home: 'https://exoplanetarchive.ipac.caltech.edu',
    kind: 'json',
    every: 24 * H,
    parse: (rows) => ({ events: (rows || []).map((r) => ({ title: `New exoplanet ${r.pl_name} around ${r.hostname}${r.sy_dist ? `, ${Number(r.sy_dist).toFixed(0)} pc away` : ''}`, summary: `Discovered ${r.disc_year} by ${r.disc_facility}. ${r.pl_rade ? `Radius ${Number(r.pl_rade).toFixed(2)} Earths. ` : ''}${r.pl_bmasse ? `Mass ${Number(r.pl_bmasse).toFixed(1)} Earths. ` : ''}${r.pl_orbper ? `Orbital period ${Number(r.pl_orbper).toFixed(2)} days. ` : ''}${r.pl_eqt ? `Equilibrium temperature ${Number(r.pl_eqt).toFixed(0)} K.` : ''}`, url: `https://exoplanetarchive.ipac.caltech.edu/overview/${encodeURIComponent(String(r.pl_name))}`, at: parseDate(r.disc_pubdate), kind: 'document', tags: ['exoplanet'] })) }),
  },
  {
    id: 'hf-papers',
    label: 'Hugging Face daily papers',
    group: 'ai',
    url: 'https://huggingface.co/api/daily_papers?limit=25&sort=trending',
    home: 'https://huggingface.co/papers',
    kind: 'json',
    every: 6 * H,
    parse: (rows) => ({ events: (rows || []).map((d) => ({ title: d.paper?.title || d.title || '', summary: String(d.paper?.ai_summary || d.paper?.summary || '').slice(0, 600), url: `https://arxiv.org/abs/${d.paper?.id}`, at: parseDate(d.publishedAt || d.paper?.publishedAt), kind: 'paper', intensity: Math.min(1, (num(d.paper?.upvotes) || 0) / 100), tags: (d.paper?.ai_keywords || []).slice(0, 4) })) }),
  },

  // Journals.
  rss('nature', 'Nature', 'journals', 'https://www.nature.com/nature.rss', { kind: 'paper', every: 3 * H }),
  rss('nature-physics', 'Nature Physics', 'journals', 'https://www.nature.com/nphys.rss', { kind: 'paper', every: 6 * H }),
  rss('science', 'Science news', 'journals', 'https://www.science.org/rss/news_current.xml', { every: 3 * H }),
  rss('prl', 'Physical Review Letters', 'journals', 'https://feeds.aps.org/rss/recent/prl.xml', { kind: 'paper', every: 6 * H, maxBytes: 300 * 1024 }),
  rss('prx', 'Physical Review X', 'journals', 'https://feeds.aps.org/rss/recent/prx.xml', { kind: 'paper', every: 12 * H, maxBytes: 300 * 1024 }),
  rss('aps-physics', 'APS Physics magazine', 'journals', 'https://feeds.aps.org/rss/recent/physics.xml', { every: 6 * H, maxBytes: 300 * 1024 }),
  rss('cell', 'Cell', 'journals', 'https://www.cell.com/cell/current.rss', { kind: 'paper', every: 12 * H }),
  rss('pnas', 'PNAS', 'journals', 'https://www.pnas.org/action/showFeed?type=etoc&feed=rss&jc=pnas', { kind: 'paper', every: 12 * H, maxBytes: 300 * 1024 }),
  rss('lancet', 'The Lancet', 'journals', 'https://www.thelancet.com/rssfeed/lancet_current.xml', { kind: 'paper', every: 12 * H }),
  rss('nejm', 'NEJM', 'journals', 'https://www.nejm.org/action/showFeed?jc=nejm&type=etoc&feed=rss', { kind: 'paper', every: 12 * H }),

  // Labs and agencies.
  rss('nasa', 'NASA news releases', 'labs', 'https://www.nasa.gov/news-release/feed/', { every: 2 * H }),
  rss('eso', 'ESO', 'labs', 'https://www.eso.org/public/news/feed/', { every: 6 * H }),
  rss('mit', 'MIT research news', 'labs', 'https://news.mit.edu/rss/research', { every: 3 * H, maxBytes: 400 * 1024 }),
  rss('nist', 'NIST', 'labs', 'https://www.nist.gov/news-events/news/rss.xml', { every: 6 * H }),
  rss('nsf', 'NSF', 'labs', 'https://www.nsf.gov/rss/rss_www_news.xml', { every: 6 * H }),
  rss('icecube-news', 'IceCube collaboration news', 'labs', 'https://icecube.wisc.edu/feed/', { every: 12 * H, maxBytes: 400 * 1024 }),
  rss('ctao', 'Cherenkov Telescope Array', 'labs', 'https://www.ctao.org/feed/', { every: 12 * H }),
  rss('seti', 'SETI Institute', 'labs', 'https://www.seti.org/rss.xml', { every: 12 * H }),
  rss('deepmind', 'Google DeepMind blog', 'ai', 'https://deepmind.google/blog/rss.xml', { every: 6 * H }),
  rss('openai', 'OpenAI news', 'ai', 'https://openai.com/news/rss.xml', { every: 6 * H, maxBytes: 300 * 1024 }),

  // Science press.
  rss('quanta', 'Quanta Magazine', 'press', 'https://www.quantamagazine.org/feed/', { every: 3 * H }),
  rss('physorg', 'Phys.org', 'press', 'https://phys.org/rss-feed/', { every: H }),
  rss('sciencedaily', 'ScienceDaily', 'press', 'https://www.sciencedaily.com/rss/top/science.xml', { every: 2 * H }),
  rss('sciam', 'Scientific American', 'press', 'https://www.scientificamerican.com/platform/syndication/rss/', { every: 3 * H }),
  rss('newscientist', 'New Scientist', 'press', 'https://www.newscientist.com/feed/home/', { every: 2 * H }),
  rss('ars', 'Ars Technica science', 'press', 'https://feeds.arstechnica.com/arstechnica/science', { every: 2 * H }),
  rss('ieee', 'IEEE Spectrum', 'press', 'https://spectrum.ieee.org/feeds/feed.rss', { every: 6 * H, maxBytes: 400 * 1024 }),
  rss('bbc-science', 'BBC science', 'press', 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', { every: 2 * H }),
  rss('guardian-science', 'Guardian science', 'press', 'https://www.theguardian.com/science/rss', { every: 2 * H }),
  rss('nyt-science', 'NYT science', 'press', 'https://rss.nytimes.com/services/xml/rss/nyt/Science.xml', { every: 3 * H }),
  rss('who', 'WHO news', 'bio', 'https://www.who.int/rss-feeds/news-english.xml', { every: 6 * H, maxBytes: 300 * 1024 }),

  // Declassified, FOIA and government research archives.
  {
    id: 'ntrs',
    label: 'NASA technical reports (declassified)',
    group: 'declassified',
    url: 'https://ntrs.nasa.gov/api/citations/search?q=declassified&page.size=25&sort=created,desc',
    home: 'https://ntrs.nasa.gov',
    kind: 'json',
    every: 24 * H,
    parse: (json) => ({ events: (json.results || []).map((r) => ({ title: r.title || '', summary: String(r.abstract || '').slice(0, 600), url: `https://ntrs.nasa.gov/citations/${r.id}`, at: parseDate(r.created || r.distributionDate), kind: 'document', tags: ['declassified', String(r.stiTypeDetails || '').toLowerCase()].filter(Boolean) })) }),
  },
  {
    id: 'osti',
    label: 'DOE OSTI (declassified & opened)',
    group: 'declassified',
    url: 'https://www.osti.gov/api/v1/records?q=declassified%20OR%20"formerly%20classified"%20OR%20"OpenNet"&rows=25&sort=publication_date+desc',
    home: 'https://www.osti.gov',
    kind: 'json',
    accept: 'application/json',
    every: 24 * H,
    parse: (rows) => ({ events: (Array.isArray(rows) ? rows : []).map((r) => ({ title: r.title || '', summary: String(r.description || '').slice(0, 600), url: (r.links || []).find((l) => l.rel === 'citation')?.href || `https://www.osti.gov/biblio/${r.osti_id}`, at: parseDate(r.publication_date || r.entry_date), kind: 'document', author: (r.authors || []).slice(0, 3).join('; '), tags: ['doe', String(r.product_type || '').toLowerCase()].filter(Boolean) })) }),
  },
  rss('blackvault', 'The Black Vault (FOIA)', 'declassified', 'https://www.theblackvault.com/documentarchive/feed/', { every: 12 * H, kind: 'document', maxBytes: 400 * 1024, home: 'https://www.theblackvault.com/documentarchive/' }),
  rss('darpa', 'DARPA', 'declassified', 'https://www.darpa.mil/rss.xml', { every: 12 * H, home: 'https://www.darpa.mil/news' }),

  // Integrity and prizes.
  {
    id: 'crossref-retractions',
    label: 'Crossref retractions',
    group: 'integrity',
    url: 'https://api.crossref.org/works?filter=update-type:retraction&sort=deposited&order=desc&rows=25&select=title,DOI,URL,deposited,update-to,container-title',
    home: 'https://retractionwatch.com',
    kind: 'json',
    every: 12 * H,
    parse: (json) => ({ events: (json.message?.items || []).map((it) => ({ title: `Retracted: ${(it.title || [])[0] || it.DOI}`, summary: `${(it['container-title'] || [])[0] || ''}. Retraction notice for ${(it['update-to'] || []).map((u) => u.DOI).join(', ')}.`, url: it.URL || `https://doi.org/${it.DOI}`, at: parseDate(it.deposited?.['date-time']), kind: 'document', intensity: 0.3, tags: ['retraction'] })) }),
  },
  rss('retractionwatch', 'Retraction Watch', 'integrity', 'https://retractionwatch.com/feed/', { every: 12 * H }),
  {
    id: 'nobel',
    label: 'Nobel Prizes',
    group: 'prizes',
    url: null,
    home: 'https://www.nobelprize.org',
    kind: 'json',
    every: 24 * H,
    urlFor: (now) => `https://api.nobelprize.org/2.1/nobelPrizes?nobelPrizeYear=${new Date(now).getUTCFullYear()}`,
    parse: (json) => ({ events: (json.nobelPrizes || []).map((p) => ({ title: `${p.categoryFullName?.en || p.category?.en} ${p.awardYear}: ${(p.laureates || []).map((l) => l.knownName?.en || l.orgName?.en).join(', ') || 'not yet awarded'}`, summary: (p.laureates || []).map((l) => l.motivation?.en).filter(Boolean).join(' | ') || p.topMotivation?.en || '', url: `https://www.nobelprize.org/prizes/${String(p.category?.en || '').toLowerCase().replace(/\s+/g, '-')}/${p.awardYear}/summary/`, at: parseDate(p.dateAwarded), kind: 'event', intensity: 0.8, tags: ['nobel'] })) }),
  },
];

// Resolve a source's URL for this moment (date-windowed APIs build it per call).
export function sourceUrl(s, now = Date.now()) {
  return s.urlFor ? s.urlFor(now) : s.url;
}

export const SOURCE_BY_ID = new Map(SOURCES.map((s) => [s.id, s]));

export function groupOf(id) {
  return GROUPS[id] || { label: id, glyph: '·', hint: '' };
}
