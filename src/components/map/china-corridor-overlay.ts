import type { ChinaCorridorControlTower } from '../../../shared/china-corridor-control-towers';

export interface ChinaCorridorOverlayProjection {
  id: string;
  polygon: [number, number][];
  nodes: Array<{ id: string; name: string; type: string; position: [number, number] }>;
  bounds: [number, number, number, number];
  center: { lat: number; lon: number };
}

export function projectChinaCorridorOverlay(
  corridor: ChinaCorridorControlTower,
): ChinaCorridorOverlayProjection {
  const polygon = corridor.boundary.map((point) => [point.lon, point.lat] as [number, number]);
  const lons = polygon.map(([lon]) => lon);
  const lats = polygon.map(([, lat]) => lat);
  const minLon = Math.min(...lons);
  const minLat = Math.min(...lats);
  const maxLon = Math.max(...lons);
  const maxLat = Math.max(...lats);
  return {
    id: corridor.id,
    polygon,
    nodes: corridor.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      type: node.type,
      position: [node.lon, node.lat],
    })),
    bounds: [minLon, minLat, maxLon, maxLat],
    center: {
      lat: (minLat + maxLat) / 2,
      lon: (minLon + maxLon) / 2,
    },
  };
}
