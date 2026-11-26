// Each run re-assesses reviewed Japan content freshness, so retention checks
// compare every other field of the carried-forward observations.
export function withoutContentFreshness(rows) {
  return rows.map((row) => {
    if (row.sourceId !== 'japan-mod') return row;
    const { content_freshness: _contentFreshness, ...claims } = row.provenance.claims;
    return { ...row, provenance: { ...row.provenance, claims } };
  });
}
