import { eciToEcf, ecfToLookAngles, gstime, jday, sunPos } from 'satellite.js';

const KM_PER_AU = 149597870.7;
const DEG = Math.PI / 180;

export function sunElevationDeg(date, lat, lon) {
  const jd = jday(date);
  const { rsun } = sunPos(jd);
  const sunEci = { x: rsun[0] * KM_PER_AU, y: rsun[1] * KM_PER_AU, z: rsun[2] * KM_PER_AU };
  const sunEcf = eciToEcf(sunEci, gstime(jd));
  const look = ecfToLookAngles({ latitude: lat * DEG, longitude: lon * DEG, height: 0 }, sunEcf);
  return look.elevation / DEG;
}
