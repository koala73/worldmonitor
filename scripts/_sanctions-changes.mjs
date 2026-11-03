const DAY = 86400000;
const RETENTION_MS = 90 * DAY;
const EVENT_LIMIT = 10000;
const ENTITY_TYPES = {
  SANCTIONS_ENTITY_TYPE_INDIVIDUAL: 'individual', SANCTIONS_ENTITY_TYPE_ENTITY: 'entity',
  SANCTIONS_ENTITY_TYPE_VESSEL: 'vessel', SANCTIONS_ENTITY_TYPE_AIRCRAFT: 'aircraft',
  SANCTIONS_ENTITY_TYPE_UNSPECIFIED: 'unspecified',
};
const programs = row => [...new Set(row.programs)].sort();
const validClock = value => Number.isSafeInteger(value) && value > 0;
const strings = value => Array.isArray(value) && value.every(v => typeof v === 'string');

function validateHistory(history, now) {
  if (history === null) return;
  if (history?.version !== 1 || !validClock(history.fetchedAt) || history.fetchedAt > now
    || !Array.isArray(history.events) || !Array.isArray(history.gaps)
    || history.heldSources !== undefined && !strings(history.heldSources)
    || history.sourceFetchedAt !== undefined && (history.sourceFetchedAt === null
      || typeof history.sourceFetchedAt !== 'object' || Array.isArray(history.sourceFetchedAt)
      || Object.values(history.sourceFetchedAt).some(at => !validClock(at) || at > history.fetchedAt))
    || history.truncatedBefore !== undefined && (!validClock(history.truncatedBefore) || history.truncatedBefore > now)
    || history.events.some(e => !validClock(e?.at) || e.at > history.fetchedAt
      || !['added', 'removed', 'amended'].includes(e.op)
      || !['list', 'id', 'name', 'et', 'effectiveAt'].every(k => typeof e[k] === 'string')
      || !strings(e.cc) || !strings(e.pr) || e.prevPr !== undefined && !strings(e.prevPr)
      || ['notice', 'url'].some(k => e[k] !== undefined && typeof e[k] !== 'string'))
    || history.gaps.some(g => !validClock(g?.from) || !validClock(g.to) || g.from > g.to
      || g.to > history.fetchedAt || typeof g.list !== 'string'
      || !['retained', 'unavailable', 'held', 'baseline-unavailable'].includes(g.reason))) {
    throw new Error('SANCTIONS_CHANGES_INVALID');
  }
}

function changeEvent(row, list, op, at, previous) {
  return {
    at, effectiveAt: row.effectiveAt, op, list, id: row.id, name: row.name,
    et: ENTITY_TYPES[row.entityType], cc: row.countryCodes, pr: programs(row),
    ...(op === 'amended' ? { prevPr: programs(previous) } : {}),
    // CSL rows carry the Federal Register citation and the issuing list's page.
    ...(row._notice ? { notice: row._notice } : {}),
    ...(row._url ? { url: row._url } : {}),
  };
}

export function buildSanctionsChanges({ history = null, previous, current, health, now }) {
  if (!validClock(now)) throw new Error('SANCTIONS_CHANGES_INVALID_CLOCK');
  validateHistory(history, now);
  let events = (history?.events ?? []).filter(e => e.at >= now - RETENTION_MS);
  const gaps = (history?.gaps ?? []).filter(g => g.to >= now - RETENTION_MS).map(g => ({ ...g }));
  const heldSources = new Set(history?.heldSources ?? []);
  for (const [list, sourceHealth] of Object.entries(health)) {
    const before = previous[list];
    const after = current[list];
    let reason = sourceHealth.status !== 'ok' ? sourceHealth.status : null;
    // A history write can succeed before snapshot publication fails. Hold the
    // next diff across that split instead of duplicating or inventing events.
    if (!reason && (!before || before.fetchedAt < (history?.sourceFetchedAt?.[list] ?? 0)
      || heldSources.has(list))) reason = 'baseline-unavailable';
    const oldRows = new Map((before?.records ?? []).map(row => [row.id, row]));
    const newRows = new Map((after?.records ?? []).map(row => [row.id, row]));
    const removed = [...oldRows.values()].filter(row => !newRows.has(row.id));
    if (!reason && removed.length > oldRows.size * 0.05) reason = 'held';
    if (reason === 'held') heldSources.add(list);
    else if (sourceHealth.status === 'ok') heldSources.delete(list);
    if (reason) {
      const from = Math.min(now, before?.fetchedAt ?? history?.fetchedAt ?? now);
      const existing = gaps.find(g => g.list === list && g.reason === reason && g.to >= from);
      if (existing) existing.to = now;
      else gaps.push({ list, from, to: now, reason });
      continue;
    }
    for (const row of newRows.values()) {
      const prior = oldRows.get(row.id);
      if (!prior) events.push(changeEvent(row, list, 'added', now));
      else if (JSON.stringify(programs(row)) !== JSON.stringify(programs(prior))) {
        events.push(changeEvent(row, list, 'amended', now, prior));
      }
    }
    for (const row of removed) events.push(changeEvent(row, list, 'removed', now));
  }
  events.sort((a, b) => a.at - b.at || a.list.localeCompare(b.list) || a.id.localeCompare(b.id) || a.op.localeCompare(b.op));
  let truncatedBefore = history?.truncatedBefore;
  if (events.length > EVENT_LIMIT) {
    truncatedBefore = Math.max(truncatedBefore ?? 0, events[events.length - EVENT_LIMIT - 1].at);
    events = events.slice(-EVENT_LIMIT);
  }
  const sourceFetchedAt = { ...history?.sourceFetchedAt };
  for (const [list, snapshot] of Object.entries(current)) {
    if (snapshot) sourceFetchedAt[list] = Math.max(sourceFetchedAt[list] ?? 0, snapshot.fetchedAt);
  }
  return { version: 1, fetchedAt: now, sourceFetchedAt, heldSources: [...heldSources], events, gaps,
    ...(truncatedBefore ? { truncatedBefore } : {}) };
}
