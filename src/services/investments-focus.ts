import type { MapLayers } from '@/types';

interface InvestmentsMapLike {
  enableLayer: (layer: keyof MapLayers) => void;
  setCenter: (lat: number, lon: number, zoom: number) => void;
}

export function focusInvestmentOnMap(
  map: InvestmentsMapLike | null,
  mapLayers: MapLayers,
  lat: number,
  lon: number
): void {
  map?.enableLayer('gulfInvestments');
  mapLayers.gulfInvestments = true;
  map?.setCenter(lat, lon, 6);
}
