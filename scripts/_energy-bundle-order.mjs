const GRID = new Set(['Regional-Energy-pgcb', 'Regional-Energy-niso', 'Regional-Energy-cammesa', 'Regional-Energy-ons']);

export function orderEnergySections(sections, turn) {
  if (!Number.isSafeInteger(turn) || turn < 0) throw new TypeError('turn must be a non-negative safe integer');
  const grid = sections.filter(section => GRID.has(section.label));
  const reports = sections.filter(section => section.label.startsWith('Regional-Energy-') && !GRID.has(section.label));
  const legacy = sections.filter(section => !section.label.startsWith('Regional-Energy-'));
  const offset = legacy.length ? Math.floor(turn / 3) % legacy.length : 0;
  const rotated = [...legacy.slice(offset), ...legacy.slice(0, offset)];
  if (turn % 3 === 0) return [...grid, ...reports, ...rotated];
  if (turn % 3 === 1) return [...reports, ...grid, ...rotated];
  return [...rotated, ...grid, ...reports];
}
