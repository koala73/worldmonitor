export function normalizeTranslateTargetLang(variant?: string, lang?: string): string;

export function preparePromptInputs(input: {
  headlines?: unknown[];
  mode?: string;
  geoContext?: string;
  variant?: string;
  lang?: string;
  maxHeadlines?: number;
  maxHeadlineLen?: number;
  maxGeoContextLen?: number;
}): {
  headlines: string[];
  geoContext: string;
  variant: string;
  safeVariant: string;
};
