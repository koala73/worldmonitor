export interface CollectorFailureMetadata {
  prismaCode?: string;
  constraint?: string;
}

export function extractCollectorFailureMetadata(body: unknown): CollectorFailureMetadata;

export function isSessionDataConflict(metadata: CollectorFailureMetadata): boolean;
