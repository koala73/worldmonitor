/**
 * ML Capabilities Detection
 * Detects device capabilities for ONNX Runtime Web
 */

import { isMobileDevice } from '@/utils';
import { ML_THRESHOLDS } from '@/config/ml-config';

export interface MLCapabilities {
  isSupported: boolean;
  isDesktop: boolean;
  hasWebGL: boolean;
  hasWebGPU: boolean;
  hasSIMD: boolean;
  hasThreads: boolean;
  estimatedMemoryMB: number;
  recommendedExecutionProvider: 'webgpu' | 'webgl' | 'wasm';
  recommendedThreads: number;
}

let cachedCapabilities: MLCapabilities | null = null;

export async function detectMLCapabilities(): Promise<MLCapabilities> {
  if (cachedCapabilities) return cachedCapabilities;

  const isDesktop = !isMobileDevice();

  const hasWebGL = checkWebGLSupport();
  const hasWebGPU = await checkWebGPUSupport();
  const hasSIMD = checkSIMDSupport();
  const hasThreads = checkThreadsSupport();
  const estimatedMemoryMB = estimateAvailableMemory();

  const isSupported = isDesktop &&
    (hasWebGL || hasWebGPU) &&
    estimatedMemoryMB >= 100;

  let recommendedExecutionProvider: 'webgpu' | 'webgl' | 'wasm';
  if (hasWebGPU) {
    recommendedExecutionProvider = 'webgpu';
  } else if (hasWebGL) {
    recommendedExecutionProvider = 'webgl';
  } else {
    recommendedExecutionProvider = 'wasm';
  }

  const recommendedThreads = hasThreads
    ? Math.min(navigator.hardwareConcurrency || 4, 4)
    : 1;

  cachedCapabilities = {
    isSupported,
    isDesktop,
    hasWebGL,
    hasWebGPU,
    hasSIMD,
    hasThreads,
    estimatedMemoryMB,
    recommendedExecutionProvider,
    recommendedThreads,
  };

  return cachedCapabilities;
}

function checkWebGLSupport(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    return !!gl;
  } catch {
    return false;
  }
}

async function checkWebGPUSupport(): Promise<boolean> {
  try {
    if (!('gpu' in navigator)) return false;
    const adapter = await (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu?.requestAdapter();
    return adapter !== null && adapter !== undefined;
  } catch {
    return false;
  }
}

function checkSIMDSupport(): boolean {
  try {
    return typeof WebAssembly.validate === 'function' &&
      WebAssembly.validate(new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123,
        3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11
      ]));
  } catch {
    return false;
  }
}

function checkThreadsSupport(): boolean {
  return typeof SharedArrayBuffer !== 'undefined';
}

function estimateAvailableMemory(): number {
  if (isMobileDevice()) return 0;

  const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (deviceMemory) {
    return Math.min(deviceMemory * 256, ML_THRESHOLDS.memoryBudgetMB);
  }

  return 256;
}

export function shouldEnableMLFeatures(): boolean {
  return cachedCapabilities?.isSupported ?? false;
}

export function getMLCapabilities(): MLCapabilities | null {
  return cachedCapabilities;
}

export function clearCapabilitiesCache(): void {
  cachedCapabilities = null;
}
