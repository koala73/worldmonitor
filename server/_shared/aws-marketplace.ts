import { AwsClient } from 'aws4fetch';
import type { AwsMarketplaceEntitlement, AwsMarketplaceRequest } from '../../shared/aws-marketplace';

export type MarketplaceIdentity = {
  productCode: string;
  customerAWSAccountId: string;
  licenseArn: string;
  customerIdentifier?: string;
  agreementId?: string;
};

export class MarketplaceError extends Error {
  constructor(public readonly code: 'CONFIG' | 'AWS_UNAVAILABLE' | 'AWS_INVALID' | 'BACKEND_UNAVAILABLE' | 'BACKEND_CONFLICT' | 'BACKEND_FORBIDDEN' | 'BACKEND_NOT_FOUND' | 'BACKEND_INVALID' | 'REGISTRATION_EXPIRED' | 'REGISTRATION_REQUIRED') {
    super(code);
    this.name = 'MarketplaceError';
  }
}

const AWS_TIMEOUT_MS = 4_000;
const BACKEND_TIMEOUT_MS = 4_000;
const MAX_ATTEMPTS = 3;
const MAX_PAGES = 100;
const MAX_RESPONSE_BYTES = 256_000;
const API_REGION = 'us-east-1';

type Env = Record<string, string | undefined>;
type AwsCall = (service: 'metering' | 'entitlement', target: string, body: unknown) => Promise<unknown>;

function required(value: string | undefined): string {
  if (!value?.trim()) throw new MarketplaceError('CONFIG');
  return value.trim();
}

function marketplaceConfig(env: Env) {
  const region = required(env.AWS_MARKETPLACE_REGION);
  if (region !== API_REGION) throw new MarketplaceError('CONFIG');
  const productCodes = required(env.AWS_MARKETPLACE_PRODUCT_CODES).split(',').map(s => s.trim());
  if (productCodes.some(s => !s) || new Set(productCodes).size !== productCodes.length) throw new MarketplaceError('CONFIG');
  const dimensionMap = JSON.parse(required(env.AWS_MARKETPLACE_DIMENSION_PLAN_MAP)) as unknown;
  if (!dimensionMap || typeof dimensionMap !== 'object' || Array.isArray(dimensionMap) ||
      Object.entries(dimensionMap).length === 0 || Object.entries(dimensionMap).some(([k, v]) => !k || typeof v !== 'string' || !v)) {
    throw new MarketplaceError('CONFIG');
  }
  return { region, productCodes, dimensionMap: dimensionMap as Record<string, string> };
}

function awsCredentials(env: Env) {
  return {
    accessKeyId: required(env.AWS_ACCESS_KEY_ID),
    secretAccessKey: required(env.AWS_SECRET_ACCESS_KEY),
    sessionToken: env.AWS_SESSION_TOKEN || undefined,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function jsonWithin(response: Response): Promise<unknown> {
  const body = await response.text();
  if (body.length > MAX_RESPONSE_BYTES) throw new MarketplaceError('AWS_INVALID');
  try { return JSON.parse(body) as unknown; } catch { throw new MarketplaceError('AWS_INVALID'); }
}

function retryable(status: number, body: unknown): boolean {
  const code = isObject(body) ? String(body.__type ?? body.code ?? '') : '';
  return status === 429 || status >= 500 || /throttl|timeout|InternalServiceError/i.test(code);
}

export function createAwsMarketplaceCall(env: Env = process.env, fetcher: typeof fetch = (...args: Parameters<typeof fetch>) => globalThis.fetch(...args)): AwsCall {
  const config = marketplaceConfig(env);
  const credentials = awsCredentials(env);
  return async (service, target, body) => {
    const host = `${service}.marketplace.${config.region}.amazonaws.com`;
    const signer = new AwsClient({ ...credentials, service: 'aws-marketplace', region: config.region, retries: 0 });
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        const requestBody = JSON.stringify(body);
        const signed = await signer.sign(`https://${host}/`, {
          method: 'POST',
          body: requestBody,
          headers: {
            'Content-Type': 'application/x-amz-json-1.1',
            'X-Amz-Target': target,
            'User-Agent': 'worldmonitor-aws-marketplace/1.0',
          },
        });
        response = await fetcher(signed.url, { method: signed.method, headers: signed.headers, body: requestBody, signal: AbortSignal.timeout(AWS_TIMEOUT_MS) });
      } catch {
        if (attempt === MAX_ATTEMPTS) throw new MarketplaceError('AWS_UNAVAILABLE');
        await new Promise(resolve => setTimeout(resolve, 100 * attempt));
        continue;
      }
      let payload: unknown;
      try { payload = await jsonWithin(response); }
      catch {
        if (response.ok) throw new MarketplaceError('AWS_INVALID');
        if (response.status < 500 || attempt === MAX_ATTEMPTS) throw new MarketplaceError('AWS_UNAVAILABLE');
        await new Promise(resolve => setTimeout(resolve, 100 * attempt));
        continue;
      }
      if (response.ok) return payload;
      if (!retryable(response.status, payload) || attempt === MAX_ATTEMPTS) throw new MarketplaceError('AWS_UNAVAILABLE');
      await new Promise(resolve => setTimeout(resolve, 100 * attempt));
    }
    throw new MarketplaceError('AWS_UNAVAILABLE');
  };
}

function validIdentity(value: unknown, allowProducts: string[]): MarketplaceIdentity {
  if (!isObject(value) || typeof value.ProductCode !== 'string' || !allowProducts.includes(value.ProductCode) ||
      typeof value.CustomerAWSAccountId !== 'string' || !/^\d{12}$/.test(value.CustomerAWSAccountId) ||
      typeof value.LicenseArn !== 'string' || !/^arn:aws[a-z-]*:license-manager:(?:[a-z0-9-]+)?:\d{12}:license:l-[a-z0-9]+$/i.test(value.LicenseArn)) {
    throw new MarketplaceError('AWS_INVALID');
  }
  const metadata = isObject(value.Metadata) ? value.Metadata : null;
  const agreementId = metadata?.AgreementId ?? value.AgreementId;
  return {
    productCode: value.ProductCode,
    customerAWSAccountId: value.CustomerAWSAccountId,
    licenseArn: value.LicenseArn,
    ...(typeof value.CustomerIdentifier === 'string' && value.CustomerIdentifier ? { customerIdentifier: value.CustomerIdentifier } : {}),
    ...(typeof agreementId === 'string' && agreementId.length <= 255 && agreementId ? { agreementId } : {}),
  };
}

export async function resolveMarketplaceCustomer(token: string, env: Env = process.env, call: AwsCall = createAwsMarketplaceCall(env)): Promise<MarketplaceIdentity> {
  if (!token || token.length > 4096) throw new MarketplaceError('AWS_INVALID');
  const config = marketplaceConfig(env);
  const resolved = await call('metering', 'AWSMPMeteringService.ResolveCustomer', { RegistrationToken: token });
  return validIdentity(resolved, config.productCodes);
}

export async function getMarketplaceEntitlements(identity: MarketplaceIdentity, env: Env = process.env, call: AwsCall = createAwsMarketplaceCall(env)): Promise<AwsMarketplaceEntitlement[]> {
  const config = marketplaceConfig(env);
  if (!config.productCodes.includes(identity.productCode)) throw new MarketplaceError('AWS_INVALID');
  const out: AwsMarketplaceEntitlement[] = [];
  const seen = new Set<string>();
  let nextToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const raw = await call('entitlement', 'AWSMPEntitlementService.GetEntitlements', {
      ProductCode: identity.productCode,
      Filter: { LICENSE_ARN: [identity.licenseArn] },
      MaxResults: 25,
      ...(nextToken ? { NextToken: nextToken } : {}),
    });
    if (!isObject(raw) || !Array.isArray(raw.Entitlements)) throw new MarketplaceError('AWS_INVALID');
    for (const row of raw.Entitlements) {
      if (!isObject(row) || row.ProductCode !== identity.productCode || row.CustomerAWSAccountId !== identity.customerAWSAccountId ||
          row.LicenseArn !== identity.licenseArn || typeof row.Dimension !== 'string' || !Object.prototype.hasOwnProperty.call(config.dimensionMap, row.Dimension) ||
          !isObject(row.Value) || !Number.isSafeInteger(row.Value.IntegerValue) || (row.Value.IntegerValue as number) <= 0 ||
          typeof row.ExpirationDate !== 'number' || !Number.isFinite(row.ExpirationDate) || row.ExpirationDate <= 0 ||
          !Number.isSafeInteger(Math.round(row.ExpirationDate * 1000))) {
        throw new MarketplaceError('AWS_INVALID');
      }
      out.push({ dimension: row.Dimension, quantity: row.Value.IntegerValue as number, expirationDate: Math.round(row.ExpirationDate * 1000) });
      if (out.length > 100) throw new MarketplaceError('AWS_INVALID');
    }
    if (raw.NextToken === undefined || raw.NextToken === null || raw.NextToken === '') return out;
    if (typeof raw.NextToken !== 'string' || seen.has(raw.NextToken)) throw new MarketplaceError('AWS_INVALID');
    seen.add(raw.NextToken);
    nextToken = raw.NextToken;
  }
  throw new MarketplaceError('AWS_INVALID');
}

export async function callMarketplaceBackend<T = unknown>(request: AwsMarketplaceRequest, env: Env = process.env, fetcher: typeof fetch = (...args: Parameters<typeof fetch>) => globalThis.fetch(...args)): Promise<T> {
  const site = required(env.CONVEX_SITE_URL);
  const secret = required(env.CONVEX_SERVER_SHARED_SECRET);
  let response: Response;
  try {
    const url = new URL('/api/internal/aws-marketplace', site);
    if (url.protocol !== 'https:') throw new MarketplaceError('CONFIG');
    response = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Convex-Shared-Secret': secret, 'User-Agent': 'worldmonitor-aws-marketplace/1.0' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof MarketplaceError) throw error;
    throw new MarketplaceError('BACKEND_UNAVAILABLE');
  }
  if (response.status === 403) throw new MarketplaceError('BACKEND_FORBIDDEN');
  if (response.status === 404) throw new MarketplaceError(request.operation === 'claimRegistration' ? 'REGISTRATION_REQUIRED' : 'BACKEND_NOT_FOUND');
  if (response.status === 409) throw new MarketplaceError('BACKEND_CONFLICT');
  if (response.status === 400) {
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    if (body?.error === 'REGISTRATION_EXPIRED') throw new MarketplaceError('REGISTRATION_EXPIRED');
    throw new MarketplaceError('BACKEND_INVALID');
  }
  if (!response.ok) throw new MarketplaceError('BACKEND_UNAVAILABLE');
  try { return await response.json() as T; } catch { throw new MarketplaceError('BACKEND_UNAVAILABLE'); }
}
