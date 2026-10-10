// Counts chokepoint crossings from AIS position reports. A crossing is a
// vessel seen inside a zone and later seen outside it.
//
// Zone membership is kept here, apart from the relay's 30-minute vessel
// table. Terrestrial AIS reaches most waterways in bursts, so a vessel is
// often silent for longer than that table keeps it. Membership survives such
// a gap for maxExitGapMs, and the next report outside the zone records the
// exit. The bound keeps an exit no more than maxExitGapMs after the last
// sighting inside the zone.
export function createTransitTracker({ zones, minDwellMs, cooldownMs, maxExitGapMs, crossings }) {
  // mmsi -> Map(zone name -> { enteredAt, lastInsideAt })
  const memberships = new Map();
  // `${mmsi}:${zone name}` -> last counted crossing ts
  const cooldowns = new Map();

  function zonesAt(lat, lon) {
    const inside = new Set();
    for (const zone of zones) {
      const dlat = lat - zone.lat;
      const dlon = lon - zone.lon;
      if (dlat * dlat + dlon * dlon <= zone.radius * zone.radius) inside.add(zone.name);
    }
    return inside;
  }

  function recordExit(mmsi, name, entry, type, now) {
    if (now - entry.lastInsideAt > maxExitGapMs) return;
    if (now - entry.enteredAt < minDwellMs) return;
    const key = mmsi + ':' + name;
    const last = cooldowns.get(key);
    if (last !== undefined && now - last < cooldownMs) return;
    let list = crossings.get(name);
    if (!list) { list = []; crossings.set(name, list); }
    list.push({ mmsi, type, ts: now });
    cooldowns.set(key, now);
  }

  function observe(mmsi, lat, lon, type, now) {
    const inside = zonesAt(lat, lon);
    const current = memberships.get(mmsi);
    if (current) {
      for (const [name, entry] of current) {
        if (inside.has(name)) continue;
        recordExit(mmsi, name, entry, type, now);
        current.delete(name);
      }
    }
    if (inside.size === 0) {
      if (current && current.size === 0) memberships.delete(mmsi);
      return;
    }
    const next = current || new Map();
    for (const name of inside) {
      const entry = next.get(name);
      // A sighting after a longer gap starts a new visit: the earlier exit
      // was never seen, so its dwell cannot carry over.
      if (entry && now - entry.lastInsideAt <= maxExitGapMs) entry.lastInsideAt = now;
      else next.set(name, { enteredAt: now, lastInsideAt: now });
    }
    memberships.set(mmsi, next);
  }

  function prune(now) {
    for (const [mmsi, current] of memberships) {
      for (const [name, entry] of current) {
        if (now - entry.lastInsideAt > maxExitGapMs) current.delete(name);
      }
      if (current.size === 0) memberships.delete(mmsi);
    }
    for (const [key, ts] of cooldowns) {
      if (now - ts >= cooldownMs) cooldowns.delete(key);
    }
  }

  return { observe, prune, memberships };
}
