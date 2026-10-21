// Re-export the shared storage evidence deriver under a server-local name
// so in-handler imports stay short. The real logic lives in
// src/shared/storage-evidence.ts so the client panel and the server RPC
// derive identical badges from the same evidence bundles.

export {
  deriveStoragePublicBadge as deriveStorageBadge,
  STORAGE_BADGE_DERIVER_VERSION as DERIVER_VERSION,
  type StoragePublicBadge as PublicBadge,
  type StorageEvidenceInput,
} from '../../../../src/shared/storage-evidence';
