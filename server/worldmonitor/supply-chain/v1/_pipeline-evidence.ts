// Re-export the shared pipeline evidence deriver under the older
// server-local name so in-handler imports keep working. The real logic
// lives in src/shared/pipeline-evidence.ts so the client panel and the
// server RPC derive identical badges from the same evidence bundles.

export {
  derivePipelinePublicBadge as derivePublicBadge,
  PIPELINE_BADGE_DERIVER_VERSION as DERIVER_VERSION,
  type PipelinePublicBadge as PublicBadge,
  type PipelineEvidenceInput,
} from '../../../../src/shared/pipeline-evidence';
