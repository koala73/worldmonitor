let storageQuotaExceeded = false;

export function isStorageQuotaExceeded(): boolean {
  return storageQuotaExceeded;
}

export function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'QuotaExceededError' || error.code === 22);
}

export function markStorageQuotaExceeded(): void {
  if (!storageQuotaExceeded) {
    storageQuotaExceeded = true;
    console.warn('[Storage] Quota exceeded — disabling further writes');
  }
}
