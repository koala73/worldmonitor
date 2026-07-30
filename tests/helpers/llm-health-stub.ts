export async function isProviderAvailable(): Promise<boolean> {
  return true;
}

export function isModelUsable(): boolean {
  return true;
}

export function recordModelFailure(): void {
  // no-op — these tests stub the health gate out entirely
}

export function recordModelSuccess(): void {
  // no-op — these tests stub the health gate out entirely
}
