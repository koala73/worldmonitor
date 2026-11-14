'use strict';

// Turns adsb.lol /v2/point responses into OpenSky /states/all rows, so the
// adsb.lol series is counted by the same aggregateStates as the OpenSky one.
const FT_TO_M = 0.3048;
const FPM_TO_MS = 0.00508;
const KT_TO_MS = 0.514444;
// readsb keeps an aircraft listed for a while after its last position. An older
// position is where it was, not where it is in this bin.
const MAX_POSITION_AGE_S = 60;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function toStateRow(ac) {
  if (!ac || typeof ac.hex !== 'string' || !finite(ac.lat) || !finite(ac.lon)) return null;
  if (finite(ac.seen_pos) && ac.seen_pos > MAX_POSITION_AGE_S) return null;
  const onGround = ac.alt_baro === 'ground';
  const baroAlt = finite(ac.alt_baro) ? ac.alt_baro * FT_TO_M : null;
  const geoAlt = finite(ac.alt_geom) ? ac.alt_geom * FT_TO_M : null;
  const rateFpm = finite(ac.baro_rate) ? ac.baro_rate : (finite(ac.geom_rate) ? ac.geom_rate : null);
  return [
    ac.hex.replace(/^~/, '').toLowerCase(),
    typeof ac.flight === 'string' ? ac.flight : null,
    null, null, null,
    ac.lon, ac.lat,
    baroAlt, onGround,
    finite(ac.gs) ? ac.gs * KT_TO_MS : null,
    finite(ac.track) ? ac.track : null,
    rateFpm === null ? null : rateFpm * FPM_TO_MS,
    null,
    geoAlt,
  ];
}

// Circles overlap, so one aircraft can appear in several responses. Keep the
// row with the freshest position.
function mergeSweep(responses) {
  const best = new Map();
  for (const response of responses) {
    if (!Array.isArray(response?.ac)) throw new TypeError('adsb.lol response has no ac array');
    for (const ac of response.ac) {
      const row = toStateRow(ac);
      if (!row) continue;
      const age = finite(ac.seen_pos) ? ac.seen_pos : 0;
      const prev = best.get(row[0]);
      if (!prev || age < prev.age) best.set(row[0], { age, row });
    }
  }
  return [...best.values()].map((entry) => entry.row);
}

module.exports = { MAX_POSITION_AGE_S, toStateRow, mergeSweep };
