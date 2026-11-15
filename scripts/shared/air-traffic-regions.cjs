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

module.exports = { US_HUBS, HUB_RADIUS_KM, CONUS_BOX, EUROPE_BOX };
