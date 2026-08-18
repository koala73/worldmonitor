type BoundedBodyResponse = {
  body?: ReadableStream<Uint8Array> | null;
  text?: () => Promise<string>;
};

/**
 * Read at most `maxBytes` of a sibling Response. Used only to classify
 * untrusted error bodies; the unread tail is discarded, never copied.
 */
export async function readBoundedResponseText(
  response: BoundedBodyResponse,
  maxBytes: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = typeof response.text === 'function'
      ? await response.text().catch(() => '')
      : '';
    return text.slice(0, maxBytes);
  }

  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = '';
  try {
    while (bytesRead < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const remaining = maxBytes - bytesRead;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      text += decoder.decode(chunk, { stream: bytesRead + chunk.byteLength < maxBytes });
      bytesRead += chunk.byteLength;
      if (chunk.byteLength < value.byteLength) break;
    }
    text += decoder.decode();
    return text;
  } catch {
    return '';
  } finally {
    await reader.cancel().catch(() => {});
  }
}
