'use strict';

// Wingbits /v1/flights geometry and rows. The request is a list of boxes, each
// centred on la/lo and w by h nm wide; the response is one entry per box. The
// rows are turned into OpenSky /states/all rows, so the Wingbits series is
// counted by the same aggregateStates as the OpenSky one.
const WINGBITS_MAX_BOX_NM = 2000;
const WINGBITS_VIEWPORT_TILE_DEGREES = 30;
const WINGBITS_MAX_VIEWPORT_AREAS = 36;
const FT_TO_M = 0.3048;
const KT_TO_MS = 0.514444;
// Wingbits lists an aircraft for a while after its last report (measured: up to
// about 90 s). An older position is where it was, not where it is in this bin.
const MAX_POSITION_AGE_MS = 60_000;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function toStateRow(f) {
  if (!f || typeof f.h !== 'string' || !finite(f.la) || !finite(f.lo)) return null;
  return [
    f.h.toLowerCase(),
    typeof f.f === 'string' ? f.f : null,
    null, null, null,
    f.lo, f.la,
    finite(f.ab) ? f.ab * FT_TO_M : null,
    f.og === true,
    finite(f.gs) ? f.gs * KT_TO_MS : null,
    finite(f.th) ? f.th : null,
    null,
    null,
    finite(f.ag) ? f.ag * FT_TO_M : null,
  ];
}

// Areas overlap at tile edges, so one aircraft can appear in several. Keep its
// latest report. A row with no report time cannot be dated and is dropped.
function stateRowsFromAreas(areas, receivedAt) {
  if (!Array.isArray(areas)) throw new TypeError('Wingbits response is not an array of areas');
  const best = new Map();
  for (const area of areas) {
    if (!Array.isArray(area?.data)) throw new TypeError('Wingbits area has no data array');
    for (const f of area.data) {
      const reportedAt = typeof f?.ra === 'string' ? Date.parse(f.ra) : NaN;
      if (!Number.isFinite(reportedAt) || receivedAt - reportedAt > MAX_POSITION_AGE_MS) continue;
      const row = toStateRow(f);
      if (!row) continue;
      const prev = best.get(row[0]);
      if (!prev || reportedAt >= prev.reportedAt) best.set(row[0], { reportedAt, row });
    }
  }
  return [...best.values()].map((entry) => entry.row);
}

function buildWingbitsViewportAreas(south, west, north, east) {
  const latTiles = Math.max(1, Math.ceil((north - south) / WINGBITS_VIEWPORT_TILE_DEGREES));
  const lonTiles = Math.max(1, Math.ceil((east - west) / WINGBITS_VIEWPORT_TILE_DEGREES));
  if (latTiles * lonTiles > WINGBITS_MAX_VIEWPORT_AREAS) return null;

  const areas = [];
  for (let latIndex = 0; latIndex < latTiles; latIndex += 1) {
    const tileSouth = south + latIndex * WINGBITS_VIEWPORT_TILE_DEGREES;
    const tileNorth = Math.min(north, tileSouth + WINGBITS_VIEWPORT_TILE_DEGREES);
    for (let lonIndex = 0; lonIndex < lonTiles; lonIndex += 1) {
      const tileWest = west + lonIndex * WINGBITS_VIEWPORT_TILE_DEGREES;
      const tileEast = Math.min(east, tileWest + WINGBITS_VIEWPORT_TILE_DEGREES);
      const centerLat = (tileSouth + tileNorth) / 2;
      const centerLon = (tileWest + tileEast) / 2;
      // A box spans w nm on every parallel, so it is narrowest in degrees at the
      // tile's equator-most edge. Sized at the centre, it left a strip at each
      // seam uncovered south of the centre (Houston, at 30N, sat in one).
      const widestLat = tileSouth <= 0 && tileNorth >= 0 ? 0 : Math.min(Math.abs(tileSouth), Math.abs(tileNorth));
      areas.push({
        alias: `viewport-${latIndex}-${lonIndex}`,
        by: 'box',
        la: centerLat,
        lo: centerLon,
        w: Math.max(1, Math.min((tileEast - tileWest) * 60 * Math.cos(widestLat * Math.PI / 180), WINGBITS_MAX_BOX_NM)),
        h: Math.max(1, Math.min((tileNorth - tileSouth) * 60, WINGBITS_MAX_BOX_NM)),
        unit: 'nm',
      });
    }
  }
  return areas;
}

module.exports = {
  MAX_POSITION_AGE_MS, WINGBITS_MAX_BOX_NM, WINGBITS_VIEWPORT_TILE_DEGREES, WINGBITS_MAX_VIEWPORT_AREAS,
  toStateRow, stateRowsFromAreas, buildWingbitsViewportAreas,
};
