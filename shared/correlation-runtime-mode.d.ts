export type CorrelationRuntimeMode = 'legacy' | 'exact' | 'fuzzy';

export declare const CORRELATION_RUNTIME_MODE_KEY: 'correlation:runtime-mode:v1';
export declare const CORRELATION_RUNTIME_MODE_ENDPOINT: '/api/correlation-runtime-mode';
export declare const CORRELATION_RUNTIME_MODES: readonly CorrelationRuntimeMode[];

export declare function resolveCorrelationRuntimeMode(value: unknown): CorrelationRuntimeMode;
