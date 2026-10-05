'use strict';

// PizzINT venues carry no lat/lng fields; their `address` is a Google Maps
// place URL. The place pin is `!3d<lat>!4d<lng>`; `@<lat>,<lng>` is only the
// camera centre, so it is the fallback. Returns null when neither parses.
function validPoint(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

function pizzintVenuePoint(venue) {
  const explicit = validPoint(venue?.lat, venue?.lng);
  if (explicit) return explicit;
  const url = String(venue?.address ?? '');
  const match = url.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/) || url.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  return match ? validPoint(Number(match[1]), Number(match[2])) : null;
}

module.exports = { pizzintVenuePoint };
