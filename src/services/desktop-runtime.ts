// Compatibility surface for service-layer consumers and test mocks. The
// canonical detector lives below services so config modules can use it without
// reversing the project's dependency direction.
export {
  detectDesktopRuntime,
  isDesktopRuntime,
  type RuntimeProbe,
} from '@/config/desktop-runtime';
