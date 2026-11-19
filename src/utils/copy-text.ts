export async function copyText(text: string): Promise<boolean> {
  await navigator.clipboard.writeText(text);
  return true;
}
