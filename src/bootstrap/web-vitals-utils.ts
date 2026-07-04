export const roundMs = (n: number | undefined): number | undefined =>
  typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : undefined;
