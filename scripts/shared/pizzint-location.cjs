'use strict';

// PizzINT venues carry no lat/lng fields; their `address` is a Google Maps
// place URL. The place pin is `!3d<lat>!4d<lng>`; `@<lat>,<lng>` is only the
// camera centre, so it is the fallback. Returns null when neither parses.
function pizzintVenuePoint(venue) {
  const lat = Number(venue?.lat), lng = Number(venue?.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0)) return { lat, lng };
  const url = String(venue?.address ?? '');
  const match = url.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/) || url.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (!match) return null;
  const point = { lat: Number(match[1]), lng: Number(match[2]) };
  return Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180 ? point : null;
}

module.exports = { pizzintVenuePoint };
