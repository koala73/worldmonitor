// Compatibility surface for service-layer importers and test stubs. The
// detector lives in src/config/desktop-runtime.ts so config modules can use it
// without importing upward into services (#5912).
export {
  detectDesktopRuntime,
  hasExplicitDesktopSignals,
  isDesktopRuntime,
  type RuntimeProbe,
} from '@/config/desktop-runtime';
