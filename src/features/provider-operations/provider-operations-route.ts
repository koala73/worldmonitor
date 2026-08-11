/** Native, owned route contract for Provider operations. */

export const PROVIDER_OPERATIONS_PATH = '/provider-operations';

export function isProviderOperationsPath(pathname: string): boolean {
  return /^\/provider-operations\/?$/.test(pathname);
}

export function providerOperationsUrl(): string {
  return PROVIDER_OPERATIONS_PATH;
}
