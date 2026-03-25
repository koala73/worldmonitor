export function parseFeedDateOrNow(value: string | null | undefined): Date {
  const parsed = value ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}
