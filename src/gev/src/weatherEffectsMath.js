function clamp01(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function range01(value, min, max) {
  if (!Number.isFinite(Number(value)) || max <= min) return 0;
  return clamp01((Number(value) - min) / (max - min));
}

/**
 * Convert source weather observations into bounded visual strengths. The WMO
 * code selects the effect family; numeric observations only control strength.
 * Missing weather fails clear instead of inventing conditions.
 */
export function deriveWeatherEffectProfile(weather) {
  if (!weather || !Number.isFinite(Number(weather.weatherCode))) {
    return {
      available: false,
      cloud: 0,
      rain: 0,
      snow: 0,
      fog: 0,
      haze: 0,
      droplets: 0,
      storm: 0,
      wind: 0,
      windDirectionDeg: 0,
    };
  }

  const code = Number(weather.weatherCode);
  const cover = range01(weather.cloudCoverPct, 8, 100);
  const precipitation = Math.max(0, Number(weather.precipitationMm) || 0);
  const wind = range01(weather.windKph, 4, 90);
  const visibilityM = Number(weather.visibilityM);
  const visibilityFog = Number.isFinite(visibilityM) ? range01(12000 - visibilityM, 0, 11500) : 0;

  const drizzle = code >= 51 && code <= 57;
  const rainCode = (code >= 61 && code <= 67) || (code >= 80 && code <= 82) || code >= 95;
  const snowCode = (code >= 71 && code <= 77) || (code >= 85 && code <= 86);
  const fogCode = code === 45 || code === 48;
  const stormCode = code >= 95;

  const observedPrecip = range01(precipitation, 0.05, 8);
  const rainFloor = drizzle ? 0.12 : rainCode ? (stormCode ? 0.68 : 0.28) : 0;
  const snowFloor = snowCode ? 0.3 : 0;
  const rain = drizzle || rainCode ? Math.max(rainFloor, observedPrecip) : 0;
  const snow = snowCode ? Math.max(snowFloor, observedPrecip) : 0;
  const fog = Math.max(fogCode ? 0.78 : 0, visibilityFog);
  const storm = stormCode ? Math.max(0.55, observedPrecip) : 0;
  const forcedCloud = stormCode ? 0.92 : (rain || snow) ? 0.7 : fogCode ? 0.55 : 0;
  const cloud = Math.max(cover, forcedCloud);

  return {
    available: true,
    cloud: clamp01(cloud),
    rain: clamp01(rain),
    snow: clamp01(snow),
    fog: clamp01(fog),
    haze: clamp01(Math.max(fog * 0.78, cloud * 0.14 + (rain + snow) * 0.2)),
    droplets: clamp01(rain * (0.58 + storm * 0.42)),
    storm: clamp01(storm),
    wind,
    windDirectionDeg: Number.isFinite(Number(weather.windDirectionDeg))
      ? ((Number(weather.windDirectionDeg) % 360) + 360) % 360
      : 0,
  };
}

/** Fade ground-weather overlays as the camera climbs above their plausible layer. */
export function weatherAltitudeFactors(altitudeM) {
  const altitude = Math.max(0, Number(altitudeM) || 0);
  return {
    precipitation: 1 - range01(altitude, 6000, 14000),
    cloud: 1 - range01(altitude, 14000, 24000),
    haze: 1 - range01(altitude, 9000, 20000),
  };
}
