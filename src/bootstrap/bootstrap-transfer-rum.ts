export type BootstrapTransferRumTier = 'fast' | 'slow';
export type BootstrapTransferRumOutcome =
  | 'complete'
  | 'abort'
  | 'http-error'
  | 'network-error'
  | 'parse-error'
  | 'cached-fallback';

export interface BootstrapTransferRumSample {
  tier: BootstrapTransferRumTier;
  outcome: BootstrapTransferRumOutcome;
  duration_ms: number;
  decoded_bytes: number;
  encoded_bytes: number;
  device_class: 'mobile' | 'desktop';
}

export type BootstrapTransferRumRejectReason =
  | 'invalid-duration'
  | 'invalid-complete-bytes'
  | 'bytes-on-incomplete';

export type BootstrapTransferRumResult =
  | { accepted: true; sample: BootstrapTransferRumSample }
  | { accepted: false; reason: BootstrapTransferRumRejectReason };

export interface BootstrapTransferRumInput {
  tier: BootstrapTransferRumTier;
  outcome: BootstrapTransferRumOutcome;
  durationMs: number;
  decodedBytes: number;
  encodedBytes: number;
  deviceClass: 'mobile' | 'desktop';
}

interface ResourceTimingReader {
  getEntriesByName(name: string, type?: string): ArrayLike<PerformanceEntry>;
}

const UTF8_ENCODER = new TextEncoder();

export function selectBootstrapTransferRumTier(
  rng: () => number = Math.random,
): BootstrapTransferRumTier {
  return rng() < 0.5 ? 'fast' : 'slow';
}

export function utf8TextBytes(text: string): number {
  return UTF8_ENCODER.encode(text).byteLength;
}

/**
 * Read the latest matching resource timing entry after the response body has
 * settled. A non-empty response with a zero size is the cross-origin-hidden
 * sentinel, not evidence of a zero-byte transfer.
 */
export function readBootstrapEncodedBodySize(
  resourceUrl: string,
  decodedBytes: number,
  timing: ResourceTimingReader = performance,
): number {
  try {
    const entries = Array.from(timing.getEntriesByName(resourceUrl, 'resource'));
    const raw = (entries[entries.length - 1] as PerformanceResourceTiming | undefined)?.encodedBodySize;
    if (!Number.isFinite(raw) || raw! < 0) return -1;
    if (raw === 0 && decodedBytes > 0) return -1;
    return Math.round(raw!);
  } catch {
    return -1;
  }
}

export function buildBootstrapTransferRumSample(
  input: BootstrapTransferRumInput,
): BootstrapTransferRumResult {
  if (!Number.isFinite(input.durationMs) || input.durationMs < 0) {
    return { accepted: false, reason: 'invalid-duration' };
  }

  if (input.outcome === 'complete') {
    if (
      !Number.isInteger(input.decodedBytes)
      || input.decodedBytes < 0
      || !Number.isInteger(input.encodedBytes)
      || input.encodedBytes < -1
    ) {
      return { accepted: false, reason: 'invalid-complete-bytes' };
    }
  } else if (input.decodedBytes !== -1 || input.encodedBytes !== -1) {
    return { accepted: false, reason: 'bytes-on-incomplete' };
  }

  return {
    accepted: true,
    sample: {
      tier: input.tier,
      outcome: input.outcome,
      duration_ms: input.durationMs,
      decoded_bytes: input.decodedBytes,
      encoded_bytes: input.encodedBytes,
      device_class: input.deviceClass,
    },
  };
}
