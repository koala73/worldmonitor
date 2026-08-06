// Shared projection for the bounded China decision-group diagnostics written
// to seed-meta. The two operator endpoints intentionally shape the result
// differently, but they must agree on which producer payloads are safe to
// publish. Keeping validation here prevents one surface from emitting a
// partial/null-filled breakdown while the other fails closed.

export function projectChinaDecisionGroupDiagnostics(
  meta,
  { groupIds = [], allowedStates, healthyQuietCause },
) {
  const states = meta?.groupStates;
  const counts = meta?.groupCounts;
  if (
    !Array.isArray(groupIds)
    || groupIds.length === 0
    || !states
    || typeof states !== 'object'
    || Array.isArray(states)
    || !counts
    || typeof counts !== 'object'
    || Array.isArray(counts)
  ) return null;

  const stateSet = allowedStates instanceof Set
    ? allowedStates
    : new Set(['available', 'partial', 'stale', 'unavailable']);
  const groupStates = Object.fromEntries(
    groupIds.map((groupId) => [groupId, states[groupId]]),
  );
  if (
    Object.values(groupStates).some((state) => !stateSet.has(state))
    || !['populated', 'partial', 'stale', 'unavailable', 'healthyQuiet', 'operationallyCovered'].every(
      (key) => Number.isInteger(counts[key])
        && counts[key] >= 0
        && counts[key] <= groupIds.length,
    )
  ) return null;

  const unavailableCauses = meta?.unavailableCauses;
  const causeOf = (groupId) => (
    unavailableCauses
    && typeof unavailableCauses === 'object'
    && !Array.isArray(unavailableCauses)
    && typeof unavailableCauses[groupId] === 'string'
      ? unavailableCauses[groupId].slice(0, 40)
      : 'unknown'
  );
  const quietGroups = [];
  const partialGroups = [];
  const staleGroups = [];
  const unavailableGroups = [];
  for (const groupId of groupIds) {
    const state = groupStates[groupId];
    if (state === 'partial') partialGroups.push(groupId);
    if (state === 'stale') staleGroups.push(groupId);
    if (state !== 'unavailable') continue;
    if (causeOf(groupId) === healthyQuietCause) quietGroups.push(groupId);
    else {
      // NOT `cause`: api/_json-response.js strips that key fleet-wide as an
      // Error.cause leak guard, so a field named `cause` never reaches the wire.
      unavailableGroups.push({ id: groupId, unavailableCause: causeOf(groupId) });
    }
  }

  return {
    groupStates,
    groupCounts: {
      populated: counts.populated,
      partial: counts.partial,
      stale: counts.stale,
      unavailable: counts.unavailable,
      healthyQuiet: counts.healthyQuiet,
      operationallyCovered: counts.operationallyCovered,
    },
    quietGroups,
    partialGroups,
    staleGroups,
    unavailableGroups,
  };
}
