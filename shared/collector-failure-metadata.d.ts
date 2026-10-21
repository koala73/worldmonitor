export interface CollectorFailureMetadata {
  prismaCode?: string;
  constraint?: string;
}

export const WRITE_RECEIPT_FIELDS: readonly string[];

export function extractCollectorFailureMetadata(body: unknown): CollectorFailureMetadata;

export function isSessionDataConflict(metadata: CollectorFailureMetadata): boolean;

export function isBotFilteredBody(body: unknown): boolean;
