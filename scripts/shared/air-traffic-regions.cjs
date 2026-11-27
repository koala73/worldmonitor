'use strict';

// The 20 busiest US passenger airports. JFK, LGA and EWR sit within 48 km of
// each other, so an aircraft between them counts at more than one hub. The
// per-hub counts measure receiver coverage at each hub, not a national total.
const US_HUBS = Object.freeze([
  { iata: 'ATL', lat: 33.6407, lon: -84.4277 },
  { iata: 'DFW', lat: 32.8998, lon: -97.0403 },
  { iata: 'DEN', lat: 39.8561, lon: -104.6737 },
  { iata: 'ORD', lat: 41.9742, lon: -87.9073 },
  { iata: 'LAX', lat: 33.9416, lon: -118.4085 },
  { iata: 'JFK', lat: 40.6413, lon: -73.7781 },
  { iata: 'LAS', lat: 36.0840, lon: -115.1537 },
  { iata: 'MCO', lat: 28.4312, lon: -81.3081 },
  { iata: 'MIA', lat: 25.7959, lon: -80.2870 },
  { iata: 'CLT', lat: 35.2144, lon: -80.9473 },
  { iata: 'SEA', lat: 47.4502, lon: -122.3088 },
  { iata: 'PHX', lat: 33.4352, lon: -112.0101 },
  { iata: 'EWR', lat: 40.6895, lon: -74.1745 },
  { iata: 'SFO', lat: 37.6213, lon: -122.3790 },
  { iata: 'IAH', lat: 29.9902, lon: -95.3368 },
  { iata: 'BOS', lat: 42.3656, lon: -71.0096 },
  { iata: 'FLL', lat: 26.0742, lon: -80.1506 },
  { iata: 'MSP', lat: 44.8848, lon: -93.2223 },
  { iata: 'LGA', lat: 40.7769, lon: -73.8740 },
  { iata: 'DTW', lat: 42.2162, lon: -83.3554 },
].map(Object.freeze));

const HUB_RADIUS_KM = 48;

// Contiguous US. Southern Florida and the Keys sit just above 24.5N.
const CONUS_BOX = Object.freeze({ south: 24.5, north: 49.5, west: -125.0, east: -66.9 });

// Western and central Europe, the control region. Its traffic does not depend
// on US airspace, so a US drop with a normal Europe count is a US event and a
// drop in both is a feed problem.
const EUROPE_BOX = Object.freeze({ south: 36.0, north: 60.0, west: -10.0, east: 25.0 });

// National markets inside EUROPE_BOX, each measured around its busiest
// airports. An aircraft within HUB_RADIUS_KM of any hub of a market counts once
// for that market, so London's five airports do not count one climber five
// times. tz is the market's local time for same-time baselines.
const EUROPE_MARKETS = Object.freeze([
  { code: 'GB', tz: 'Europe/London', hubs: [
    { iata: 'LHR', lat: 51.4700, lon: -0.4543 }, { iata: 'LGW', lat: 51.1537, lon: -0.1821 },
    { iata: 'MAN', lat: 53.3537, lon: -2.2750 }, { iata: 'STN', lat: 51.8860, lon: 0.2389 },
    { iata: 'EDI', lat: 55.9500, lon: -3.3725 }, { iata: 'BHX', lat: 52.4539, lon: -1.7480 },
    { iata: 'GLA', lat: 55.8719, lon: -4.4331 }, { iata: 'BRS', lat: 51.3827, lon: -2.7191 },
  ] },
  { code: 'FR', tz: 'Europe/Paris', hubs: [
    { iata: 'CDG', lat: 49.0097, lon: 2.5479 }, { iata: 'ORY', lat: 48.7262, lon: 2.3652 },
    { iata: 'NCE', lat: 43.6584, lon: 7.2159 }, { iata: 'LYS', lat: 45.7256, lon: 5.0811 },
    { iata: 'MRS', lat: 43.4393, lon: 5.2214 }, { iata: 'TLS', lat: 43.6293, lon: 1.3638 },
    { iata: 'BOD', lat: 44.8283, lon: -0.7156 }, { iata: 'NTE', lat: 47.1532, lon: -1.6107 },
  ] },
  { code: 'DE', tz: 'Europe/Berlin', hubs: [
    { iata: 'FRA', lat: 50.0379, lon: 8.5622 }, { iata: 'MUC', lat: 48.3538, lon: 11.7861 },
    { iata: 'BER', lat: 52.3667, lon: 13.5033 }, { iata: 'DUS', lat: 51.2895, lon: 6.7668 },
    { iata: 'HAM', lat: 53.6304, lon: 9.9882 }, { iata: 'CGN', lat: 50.8659, lon: 7.1427 },
    { iata: 'STR', lat: 48.6899, lon: 9.2220 },
  ] },
  { code: 'ES', tz: 'Europe/Madrid', hubs: [
    { iata: 'MAD', lat: 40.4983, lon: -3.5676 }, { iata: 'BCN', lat: 41.2974, lon: 2.0833 },
    { iata: 'PMI', lat: 39.5517, lon: 2.7388 }, { iata: 'AGP', lat: 36.6749, lon: -4.4991 },
    { iata: 'ALC', lat: 38.2822, lon: -0.5582 }, { iata: 'VLC', lat: 39.4893, lon: -0.4816 },
    { iata: 'SVQ', lat: 37.4180, lon: -5.8931 }, { iata: 'BIO', lat: 43.3011, lon: -2.9106 },
  ] },
  { code: 'IT', tz: 'Europe/Rome', hubs: [
    { iata: 'FCO', lat: 41.8003, lon: 12.2389 }, { iata: 'MXP', lat: 45.6306, lon: 8.7281 },
    { iata: 'BGY', lat: 45.6739, lon: 9.7042 }, { iata: 'NAP', lat: 40.8860, lon: 14.2908 },
    { iata: 'CTA', lat: 37.4668, lon: 15.0664 }, { iata: 'VCE', lat: 45.5053, lon: 12.3519 },
    { iata: 'BLQ', lat: 44.5354, lon: 11.2887 }, { iata: 'PMO', lat: 38.1760, lon: 13.0910 },
  ] },
].map((market) => Object.freeze({ ...market, hubs: Object.freeze(market.hubs.map(Object.freeze)) })));

module.exports = { US_HUBS, HUB_RADIUS_KM, CONUS_BOX, EUROPE_BOX, EUROPE_MARKETS };
