const DEFAULT_CHUNK_SIZE_WARNING_LIMIT_KB = 1200;

const CHUNK_SIZE_WARNING_EXCEPTIONS_KB = new Map([
  ['GlobeMap', 2000],
]);

const EXPECTED_EMPTY_RPC_CLIENT_CHUNK = 'rpc-client-cyber-v1';

interface ChunkSizeWarningInput {
  name: string;
  fileName: string;
  sizeBytes: number;
}

interface RollupWarningLike {
  code?: string;
  names?: string[];
}

export function chunkSizeWarningLimitKb(chunkName: string): number {
  return CHUNK_SIZE_WARNING_EXCEPTIONS_KB.get(chunkName)
    ?? DEFAULT_CHUNK_SIZE_WARNING_LIMIT_KB;
}

export function getChunkSizeWarning({
  name,
  fileName,
  sizeBytes,
}: ChunkSizeWarningInput): string | null {
  const sizeKb = sizeBytes / 1000;
  const limitKb = chunkSizeWarningLimitKb(name);
  if (sizeKb <= limitKb) return null;

  return `Chunk ${fileName} is ${sizeKb.toFixed(2)} kB after minification. Its "${name}" budget is ${limitKb} kB.`;
}

export function isExpectedEmptyRpcClientWarning(
  warning: RollupWarningLike,
  cyberLayerEnabled: boolean,
): boolean {
  return !cyberLayerEnabled
    && warning.code === 'EMPTY_BUNDLE'
    && warning.names?.length === 1
    && warning.names[0] === EXPECTED_EMPTY_RPC_CLIENT_CHUNK;
}
