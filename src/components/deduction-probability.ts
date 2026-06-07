export interface DeductionProbabilityBadge {
  label: string;
  remainder: string;
  isRange: boolean;
}

const RANGE_SEPARATOR_RE = String.raw`(?:%?\s*[-–—]\s*)`;
const RANGE_RE = new RegExp(String.raw`\b(\d{1,3})\s*${RANGE_SEPARATOR_RE}(\d{1,3})\s*%`);
const LEADING_RANGE_RE = new RegExp(String.raw`^\s*(\d{1,3})\s*${RANGE_SEPARATOR_RE}(\d{1,3})\s*%\s*[:\s-]*`);
const SINGLE_RE = /\b(\d{1,3})\s*%/;
const LEADING_SINGLE_RE = /^\s*(\d{1,3})\s*%\s*[:\s-]*/;

function isValidProbability(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 100;
}

function formatRangeLabel(low: number, high: number): string {
  return `${low}-${high}% range`;
}

function formatSingleLabel(value: number): string {
  return `~${value}%`;
}

function toValidInt(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return isValidProbability(parsed) ? parsed : null;
}

export function extractDeductionProbability(text: string, options: { leadingOnly?: boolean } = {}): DeductionProbabilityBadge | null {
  const rangeMatch = (options.leadingOnly ? LEADING_RANGE_RE : RANGE_RE).exec(text);
  if (rangeMatch) {
    const low = toValidInt(rangeMatch[1] ?? '');
    const high = toValidInt(rangeMatch[2] ?? '');
    if (low !== null && high !== null) {
      return {
        label: formatRangeLabel(low, high),
        remainder: options.leadingOnly ? text.slice(rangeMatch[0].length).trim() : text,
        isRange: true,
      };
    }
    return null;
  }

  const singleMatch = (options.leadingOnly ? LEADING_SINGLE_RE : SINGLE_RE).exec(text);
  if (!singleMatch) return null;

  const value = toValidInt(singleMatch[1] ?? '');
  if (value === null) return null;

  return {
    label: formatSingleLabel(value),
    remainder: options.leadingOnly ? text.slice(singleMatch[0].length).trim() : text,
    isRange: false,
  };
}
