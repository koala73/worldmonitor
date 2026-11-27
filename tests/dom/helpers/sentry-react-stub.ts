/**
 * Stand-in for `@sentry/react`, which only pro-test/ installs. CI's dom-tests
 * job installs the root dependencies alone, so a DOM test that loads a /pro
 * module would fail to resolve the import (vitest.dom.config.mts aliases it
 * here). Reporting is a no-op; tests that need to see a report mock it.
 */
export const addBreadcrumb = (): void => {};
export const captureException = (): string => '';
export const captureMessage = (): string => '';
