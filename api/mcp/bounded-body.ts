type BoundedBodyResponse = {
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

/**
 * Read an upstream response with exact raw-byte accounting. An advertised
 * oversize response is rejected before the stream is pulled; a chunked or
 * understated response is cancelled as soon as it crosses the cap.
 */
export async function readBoundedResponseBody(
  response: BoundedBodyResponse,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new TypeError('maxBytes must be a non-negative finite number');
  }

  const contentLengthRaw = response.headers?.get('content-length');
  if (contentLengthRaw !== null && contentLengthRaw !== undefined && contentLengthRaw !== '') {
    const contentLength = Number(contentLengthRaw);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      if (response.body) {
        await response.body.cancel().catch(() => {});
      }
      throw new ResponseBodyTooLargeError(maxBytes);
    }
  }

  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ResponseBodyTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (!(error instanceof ResponseBodyTooLargeError)) {
      await reader.cancel().catch(() => {});
    }
    throw error;
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

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
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new TypeError('maxBytes must be a non-negative finite number');
  }

  const contentLengthRaw = request.headers.get('content-length');
  if (contentLengthRaw !== null && contentLengthRaw !== '') {
    const contentLength = Number(contentLengthRaw);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      if (request.body) {
        await request.body.cancel().catch(() => {});
      }
      throw new RequestBodyTooLargeError(maxBytes);
    }
  }

  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new RequestBodyTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (!(err instanceof RequestBodyTooLargeError)) {
      await reader.cancel().catch(() => {});
    }
    throw err;
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
