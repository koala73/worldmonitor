export type ImfDatasetKey = 'imfMacro' | 'imfGrowth' | 'imfLabor' | 'imfExternal';
export const IMF_DATASETS: Record<ImfDatasetKey, { fields: readonly string[] }>;
export function parseImfDataset(key: ImfDatasetKey, value: unknown): {
  countries: Record<string, Record<string, number | null>>;
  seededAt: number;
} | undefined;
