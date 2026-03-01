type MapView = 'global' | 'america' | 'mena' | 'eu' | 'asia' | 'latam' | 'africa' | 'oceania';

const ASIA_EAST_TIMEZONES = new Set([
  'Asia/Tokyo', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Hong_Kong',
  'Asia/Taipei', 'Asia/Singapore',
]);

function timezoneToRegion(tz: string): MapView | null {
  if (ASIA_EAST_TIMEZONES.has(tz)) return 'asia';
  const prefix = tz.split('/')[0];
  switch (prefix) {
    case 'America':
    case 'US':
    case 'Canada':
      return 'america';
    case 'Europe':
      return 'eu';
    case 'Africa':
      return 'africa';
    case 'Asia':
      return 'mena';
    case 'Australia':
    case 'Pacific':
      return 'oceania';
    default:
      return null;
  }
}

function coordsToRegion(lat: number, lon: number): MapView {
  if (lat > 15 && lon > 60 && lon < 150) return 'asia';
  if (lat > 10 && lat < 45 && lon > 25 && lon < 65) return 'mena';
  if (lat > -40 && lat < 40 && lon > -25 && lon < 55) return 'africa';
  if (lat > 35 && lat < 72 && lon > -25 && lon < 45) return 'eu';
  if (lat > -60 && lat < 15 && lon > -90 && lon < -30) return 'latam';
  if (lat > 15 && lon > -170 && lon < -50) return 'america';
  if (lat < 0 && lon > 100) return 'oceania';
  return 'global';
}

function getGeolocationPosition(timeout: number): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      timeout,
      maximumAge: 300_000,
    });
  });
}

export async function resolveUserRegion(): Promise<MapView> {
  let tzRegion: MapView = 'global';
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    tzRegion = timezoneToRegion(tz) ?? 'global';
  } catch {
    // Intl unavailable
  }

  try {
    if (typeof navigator === 'undefined' || !navigator.permissions) throw 0;
    const status = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
    if (status.state === 'granted') {
      const pos = await getGeolocationPosition(3000);
      return coordsToRegion(pos.coords.latitude, pos.coords.longitude);
    }
  } catch {
    // permissions.query unsupported or geolocation failed
  }

  return tzRegion;
}
