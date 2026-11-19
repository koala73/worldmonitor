// Satellite positions from two-line elements. A compact Kepler propagator
// with J2 secular drift: accurate to a few tens of kilometres over the hours
// a dashboard session lasts, which is all a terminal map can show.
import { DEG, wrapLon } from './geo.mjs';

const MU = 398600.4418; // km^3/s^2
const RE = 6378.137; // km
const J2 = 1.08262668e-3;

export function parseTle(line1, line2) {
  const l1 = String(line1 || '');
  const l2 = String(line2 || '');
  if (l1.length < 60 || l2.length < 60) return null;
  const yy = Number(l1.slice(18, 20));
  const doy = Number(l1.slice(20, 32));
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  const epoch = Date.UTC(year, 0, 1) + (doy - 1) * 86400000;
  const inclination = Number(l2.slice(8, 16));
  const raan = Number(l2.slice(17, 25));
  const eccentricity = Number(`0.${l2.slice(26, 33).trim()}`);
  const argPerigee = Number(l2.slice(34, 42));
  const meanAnomaly = Number(l2.slice(43, 51));
  const meanMotion = Number(l2.slice(52, 63)); // rev/day
  if (![inclination, raan, eccentricity, argPerigee, meanAnomaly, meanMotion].every(Number.isFinite) || meanMotion <= 0) return null;
  const n = (meanMotion * 2 * Math.PI) / 86400; // rad/s
  const a = Math.cbrt(MU / (n * n));
  return { epoch, inclination, raan, eccentricity, argPerigee, meanAnomaly, meanMotion, n, a };
}

function gmst(ms) {
  const d = ms / 86400000 - 10957.5;
  const g = (280.46061837 + 360.98564736629 * d) % 360;
  return (g < 0 ? g + 360 : g) * DEG;
}

// Sub-satellite point and altitude at time `ms`.
export function propagate(tle, ms) {
  const dt = (ms - tle.epoch) / 1000;
  const { a, eccentricity: e, n } = tle;
  const i = tle.inclination * DEG;
  const p = a * (1 - e * e);
  const j2f = 1.5 * J2 * (RE / p) ** 2 * n;
  const raan = tle.raan * DEG - j2f * Math.cos(i) * dt;
  const argp = tle.argPerigee * DEG + 0.5 * j2f * (5 * Math.cos(i) ** 2 - 1) * dt;
  let M = tle.meanAnomaly * DEG + n * dt * (1 + 0.75 * J2 * (RE / p) ** 2 * Math.sqrt(1 - e * e) * (3 * Math.cos(i) ** 2 - 1));
  M = ((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  let E = M;
  for (let k = 0; k < 8; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const ν = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
  const r = a * (1 - e * Math.cos(E));
  const u = argp + ν;
  const cosu = Math.cos(u);
  const sinu = Math.sin(u);
  const cosΩ = Math.cos(raan);
  const sinΩ = Math.sin(raan);
  const cosi = Math.cos(i);
  const sini = Math.sin(i);
  const x = r * (cosΩ * cosu - sinΩ * sinu * cosi);
  const y = r * (sinΩ * cosu + cosΩ * sinu * cosi);
  const z = r * (sinu * sini);
  const θ = gmst(ms);
  const lon = wrapLon((Math.atan2(y, x) - θ) / DEG);
  const lat = Math.atan2(z, Math.sqrt(x * x + y * y)) / DEG;
  return { lat, lon, altKm: r - RE, periodMin: (2 * Math.PI) / n / 60 };
}

// Ground track: positions from now-back to now+ahead minutes.
export function groundTrack(tle, ms, { back = 0, ahead = 95, stepMin = 1 } = {}) {
  const pts = [];
  for (let m = -back; m <= ahead; m += stepMin) {
    const p = propagate(tle, ms + m * 60000);
    pts.push([p.lon, p.lat]);
  }
  return pts;
}
