export interface CountryTextArtifact {
  filename: string;
  mimeType: 'text/markdown;charset=utf-8' | 'text/html;charset=utf-8';
  content: string;
}

export type CountryDownloadResult = { state: 'attempted' | 'unsupported' | 'unconfirmed' | 'host-accepted' | 'error' };
export type CountryTextDownload = (artifact: CountryTextArtifact, signal: AbortSignal) => Promise<CountryDownloadResult>;
export const COUNTRY_EXPORT_TEXT_BYTES = 1024 * 1024;
export const COUNTRY_EXPORT_REQUEST_BYTES = 2 * 1024 * 1024;

export class CountryDownloadRequestError extends Error {
  constructor(public readonly kind: 'rpc' | 'timeout' | 'closed' | 'size') { super(kind); }
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function hostSupportsCountryDownload(initialized: unknown): boolean {
  return object(initialized) && initialized.protocolVersion === '2026-01-26'
    && object(initialized.hostCapabilities) && object(initialized.hostCapabilities.downloadFile);
}

export function createHostCountryDownload(
  initialization: () => unknown,
  request: (method: string, params: object, signal: AbortSignal) => Promise<unknown>,
): CountryTextDownload {
  return async (artifact, signal) => {
    if (signal.aborted) return { state: 'unconfirmed' };
    if (!hostSupportsCountryDownload(initialization())) return { state: 'unsupported' };
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(artifact.filename)
      || !['text/markdown;charset=utf-8', 'text/html;charset=utf-8'].includes(artifact.mimeType)
      || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(artifact.content)
      || new TextEncoder().encode(artifact.content).length > COUNTRY_EXPORT_TEXT_BYTES) return { state: 'error' };
    const params = { contents: [{ type: 'resource', resource: {
      uri: `file:///${artifact.filename}`, mimeType: artifact.mimeType, text: artifact.content,
    } }] };
    if (new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: Number.MAX_SAFE_INTEGER, method: 'ui/download-file', params })).length > COUNTRY_EXPORT_REQUEST_BYTES) return { state: 'error' };
    try {
      const result = await request('ui/download-file', params, signal);
      if (signal.aborted || !object(result) || ('isError' in result && typeof result.isError !== 'boolean')) return { state: 'unconfirmed' };
      return { state: result.isError ? 'error' : 'host-accepted' };
    } catch (error) {
      return { state: !signal.aborted && error instanceof CountryDownloadRequestError && ['rpc', 'size'].includes(error.kind) ? 'error' : 'unconfirmed' };
    }
  };
}

export const attemptWebCountryDownload: CountryTextDownload = async (artifact, signal) => {
  if (signal.aborted) return { state: 'unconfirmed' };
  const url = URL.createObjectURL(new Blob([artifact.content], { type: artifact.mimeType }));
  const link = document.createElement('a');
  link.href = url; link.download = artifact.filename;
  document.body.append(link);
  try { link.click(); } finally {
    link.remove();
    if (artifact.mimeType === 'text/html;charset=utf-8') setTimeout(() => URL.revokeObjectURL(url), 30_000);
    else URL.revokeObjectURL(url);
  }
  return { state: 'attempted' };
};

export function countryDownloadMessage(result: CountryDownloadResult): string {
  switch (result.state) {
    case 'attempted': return 'Download attempted. Check your browser downloads.';
    case 'unsupported': return 'This host does not support file downloads.';
    case 'unconfirmed': return 'The download request is unconfirmed. Check your downloads before trying again.';
    case 'host-accepted': return 'Host accepted the download request. File completion is not confirmed.';
    case 'error': return 'The download request could not be accepted.';
  }
}
