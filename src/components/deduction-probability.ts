export interface DeductionProbabilityBadge {
  label: string;
  remainder: string;
  isRange: boolean;
}

const RANGE_SEPARATOR_RE = String.raw`(?:%?\s*[-–—]\s*)`;
const RANGE_RE_GLOBAL = new RegExp(String.raw`\b(\d{1,3})\s*${RANGE_SEPARATOR_RE}(\d{1,3})\s*%`, 'g');
const LEADING_RANGE_RE = new RegExp(String.raw`^\s*(\d{1,3})\s*${RANGE_SEPARATOR_RE}(\d{1,3})\s*%\s*[:\s-]*`);
const SINGLE_RE_GLOBAL = /\b(\d{1,3})\s*%/g;
const LEADING_SINGLE_RE = /^\s*(\d{1,3})\s*%\s*[:\s-]*/;

interface Span {
  start: number;
  end: number;
}

interface Candidate extends DeductionProbabilityBadge {
  start: number;
}

function isValidProbability(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 100;
}

function formatRangeLabel(low: number, high: number): string {
  return `${low}-${high}%`;
}

function formatSingleLabel(value: number): string {
  return `~${value}%`;
}

function toValidInt(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return isValidProbability(parsed) ? parsed : null;
}

function isInsideSpan(index: number, spans: Span[]): boolean {
  return spans.some(span => index >= span.start && index < span.end);
}

export function extractDeductionProbability(text: string, options: { leadingOnly?: boolean } = {}): DeductionProbabilityBadge | null {
  const rangeMatch = options.leadingOnly ? LEADING_RANGE_RE.exec(text) : null;
  if (rangeMatch) {
    const low = toValidInt(rangeMatch[1] ?? '');
    const high = toValidInt(rangeMatch[2] ?? '');
    if (low !== null && high !== null && low <= high) {
      return {
        label: formatRangeLabel(low, high),
        remainder: text.slice(rangeMatch[0].length).trim(),
        isRange: true,
      };
    }
    return null;
  }

  if (!options.leadingOnly) {
    const invalidRangeSpans: Span[] = [];
    const candidates: Candidate[] = [];
    for (const match of text.matchAll(RANGE_RE_GLOBAL)) {
      const low = toValidInt(match[1] ?? '');
      const high = toValidInt(match[2] ?? '');
      if (low !== null && high !== null && low <= high) {
        candidates.push({
          start: match.index ?? 0,
          label: formatRangeLabel(low, high),
          remainder: text,
          isRange: true,
        });
        continue;
      }
      invalidRangeSpans.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
    }

    for (const match of text.matchAll(SINGLE_RE_GLOBAL)) {
      if (isInsideSpan(match.index ?? 0, invalidRangeSpans)) continue;
      const value = toValidInt(match[1] ?? '');
      if (value === null) continue;
      candidates.push({
        start: match.index ?? 0,
        label: formatSingleLabel(value),
        remainder: text,
        isRange: false,
      });
    }

    candidates.sort((a, b) => a.start - b.start);
    const candidate = candidates[0];
    if (!candidate) return null;
    return {
      label: candidate.label,
      remainder: candidate.remainder,
      isRange: candidate.isRange,
    };
  }

  const singleMatch = LEADING_SINGLE_RE.exec(text);
  if (!singleMatch) return null;

  const value = toValidInt(singleMatch[1] ?? '');
  if (value === null) return null;

  return {
    label: formatSingleLabel(value),
    remainder: options.leadingOnly ? text.slice(singleMatch[0].length).trim() : text,
    isRange: false,
  };
}
