// Counts chokepoint transits from AIS position reports. A transit is a vessel
// seen in a gate on one side of a chokepoint and later in a gate on the other
// side (CHOKEPOINT_TRANSIT_GATES). Ports, anchorages and ferries that stay on
// one side never reach the opposite gate, so they are not counted.
//
// The last gate sighting is kept apart from the relay's 30-minute vessel
// table. Terrestrial AIS reaches most waterways in bursts, so a vessel is often
// silent for longer than that table keeps it. A sighting survives for
// maxTransitMs, which bounds the time between the two gates.
export function createTransitTracker({ gates, maxTransitMs, cooldownMs, crossings, onGateObservation }) {
  const compiled = Object.entries(gates).map(([name, sides]) => {
    const circles = [...sides.a.map((c) => ['a', c]), ...sides.b.map((c) => ['b', c])];
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const [, [lat, lon, r]] of circles) {
      minLat = Math.min(minLat, lat - r); maxLat = Math.max(maxLat, lat + r);
      minLon = Math.min(minLon, lon - r); maxLon = Math.max(maxLon, lon + r);
    }
    return { name, circles, minLat, maxLat, minLon, maxLon };
  });
  // mmsi -> Map(chokepoint name -> { side, ts })
  const sightings = new Map();
  // `${mmsi}:${chokepoint name}` -> last counted transit ts
  const cooldowns = new Map();

  function sideAt(gate, lat, lon) {
    if (lat < gate.minLat || lat > gate.maxLat || lon < gate.minLon || lon > gate.maxLon) return null;
    for (const [side, [clat, clon, r]] of gate.circles) {
      const dlat = lat - clat;
      const dlon = lon - clon;
      if (dlat * dlat + dlon * dlon <= r * r) return side;
    }
    return null;
  }

  function recordTransit(mmsi, name, type, direction, now) {
    const key = mmsi + ':' + name;
    const last = cooldowns.get(key);
    if (last !== undefined && now - last < cooldownMs) return;
    let list = crossings.get(name);
    if (!list) { list = []; crossings.set(name, list); }
    list.push({ mmsi, type, ts: now, direction });
    cooldowns.set(key, now);
  }

  function observe(mmsi, lat, lon, type, now) {
    for (const gate of compiled) {
      const side = sideAt(gate, lat, lon);
      if (!side) continue;
      if (onGateObservation) {
        onGateObservation(mmsi, gate.name, side, type, now);
        continue;
      }
      let seen = sightings.get(mmsi);
      const previous = seen?.get(gate.name);
      if (previous && previous.side !== side && now - previous.ts <= maxTransitMs) {
        recordTransit(mmsi, gate.name, type, previous.side + side, now);
      }
      if (!seen) { seen = new Map(); sightings.set(mmsi, seen); }
      seen.set(gate.name, { side, ts: now });
    }
  }

  function prune(now) {
    for (const [mmsi, seen] of sightings) {
      for (const [name, entry] of seen) {
        if (now - entry.ts > maxTransitMs) seen.delete(name);
      }
      if (seen.size === 0) sightings.delete(mmsi);
    }
    for (const [key, ts] of cooldowns) {
      if (now - ts >= cooldownMs) cooldowns.delete(key);
    }
  }

  return { observe, prune, sightings };
}
