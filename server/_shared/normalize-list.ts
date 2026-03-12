export function toUniqueSortedLimited(values: string[], limit: number): string[] {
  return Array.from(new Set(values)).sort().slice(0, limit);
}
