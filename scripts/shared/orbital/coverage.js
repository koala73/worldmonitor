import mask from './land-coast-mask.data.js';
import missionCoverage from './mission-coverage.data.js';

function decodeRow(encoded) {
  const landStarts = [];
  let col = 0;
  encoded.split('.').forEach((run, index) => {
    const length = parseInt(run, 36);
    if (index % 2 === 1) landStarts.push([col, col + length]);
    col += length;
  });
  return landStarts;
}

const decodedGrids = new Map();

function gridHas(rows, cellDeg, lat, lon) {
  const columns = Math.round(360 / cellDeg);
  const row = Math.min(rows.length - 1, Math.max(0, Math.floor((90 - lat) / cellDeg)));
  const col = ((Math.floor((lon + 180) / cellDeg) % columns) + columns) % columns;
  let decoded = decodedGrids.get(rows);
  if (!decoded) {
    decoded = new Map();
    decodedGrids.set(rows, decoded);
  }
  let spans = decoded.get(row);
  if (!spans) {
    spans = decodeRow(rows[row]);
    decoded.set(row, spans);
  }
  return spans.some(([start, end]) => col >= start && col < end);
}

export function isLandOrCoast(lat, lon) {
  return gridHas(mask.rows, mask.cellDeg, lat, lon);
}

export function acquiresAt(coverage, point, direction) {
  if (coverage === 'global') return true;
  if (coverage === 'land-coast') return isLandOrCoast(point.lat, point.lon);
  const grids = missionCoverage.missions[coverage]?.grids;
  if (!grids) return false;
  const rows = grids.all ?? grids[direction];
  return rows ? gridHas(rows, missionCoverage.cellDeg, point.lat, point.lon)
    : Object.values(grids).some((either) => gridHas(either, missionCoverage.cellDeg, point.lat, point.lon));
}
