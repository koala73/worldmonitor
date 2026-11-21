type BoundedBodySource = {
  body?: ReadableStream<Uint8Array> | null;
  headers?: { get(name: string): string | null };
  text?: () => Promise<string>;
};

/**
 * Thrown when a request body exceeds the configured byte cap — either via
 * advertised `Content-Length` or while streaming the body. Callers must
 * reject without parsing.
 */
export class RequestBodyTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`);
    this.name = 'RequestBodyTooLargeError';
    this.maxBytes = maxBytes;
  }
}

export class ResponseBodyTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`MCP server response exceeds ${maxBytes} bytes`);
    this.name = 'ResponseBodyTooLargeError';
    this.maxBytes = maxBytes;
  }
}

async function readBoundedBody(
  source: BoundedBodySource,
  maxBytes: number,
  createTooLargeError: (maxBytes: number) => Error,
): Promise<Uint8Array> {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new TypeError('maxBytes must be a non-negative finite number');
  }

  const contentLengthRaw = source.headers?.get('content-length');
  if (contentLengthRaw !== null && contentLengthRaw !== undefined && contentLengthRaw !== '') {
    const contentLength = Number(contentLengthRaw);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      if (source.body) await source.body.cancel().catch(() => {});
      throw createTooLargeError(maxBytes);
    }
  }

  if (!source.body) return new Uint8Array();

  const reader = source.body.getReader();
  // Hold what arrived in one buffer that grows geometrically, capped at
  // maxBytes. Reserving the full cap up front cost it on every read (the news
  // digest runs 20 concurrent 5 MiB reads on a 128 MB Edge isolate), and
  // keeping one array per read cost heap per read, so a body trickled as
  // many tiny chunks grew with the number of reads instead of the bytes.
  const cap = Math.floor(maxBytes);
  let body = new Uint8Array(0);
  let total = 0;
  let cancelled = false;
  const cancel = async () => {
    if (cancelled) return;
    cancelled = true;
    await reader.cancel().catch(() => {});
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (total + value.byteLength > maxBytes) {
        await cancel();
        throw createTooLargeError(maxBytes);
      }
      const needed = total + value.byteLength;
      if (needed > body.byteLength) {
        const grown = new Uint8Array(Math.min(cap, Math.max(needed, body.byteLength * 2, 64 * 1024)));
        grown.set(body.subarray(0, total));
        body = grown;
      }
      // Copied, never retained: a source may reuse one buffer across reads.
      body.set(value, total);
      total = needed;
    }
  } catch (error) {
    await cancel();
    throw error;
  }

  return body.slice(0, total);
}

/**
 * Read an upstream response with exact raw-byte accounting. An advertised
 * oversize response is rejected before the stream is pulled; a chunked or
 * understated response is cancelled as soon as it crosses the cap.
 */
export async function readBoundedResponseBody(
  response: BoundedBodySource,
  maxBytes: number,
): Promise<Uint8Array> {
  return readBoundedBody(response, maxBytes, (limit) => new ResponseBodyTooLargeError(limit));
}

/**
 * Read at most `maxBytes` of a sibling Response. Used only to classify
 * untrusted error bodies; the unread tail is discarded, never copied.
 */
export async function readBoundedResponseText(
  response: BoundedBodySource,
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

/**
 * Read a request body with an early `Content-Length` reject and a streaming
 * byte cap. Mirrors `api/security/report.js` / the railway control plane:
 * oversized bodies are cancelled rather than buffered to completion, and the
 * unread tail is never copied into the returned buffer.
 */
export async function readBoundedRequestBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  return readBoundedBody(request, maxBytes, (limit) => new RequestBodyTooLargeError(limit));
}
