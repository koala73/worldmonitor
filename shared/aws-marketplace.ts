export const AWS_MARKETPLACE_PRINCIPAL_PREFIX = "aws-marketplace:";
export const AWS_MARKETPLACE_VERIFICATION_MAX_AGE_MS = 15 * 60_000;
export const AWS_MARKETPLACE_REFRESH_INTERVAL_MS = 5 * 60_000;

export function isAwsMarketplacePrincipal(userId: string): boolean {
  return userId.startsWith(AWS_MARKETPLACE_PRINCIPAL_PREFIX);
}

export type AwsMarketplaceEntitlement = {
  dimension: string;
  quantity: number;
  expirationDate: number;
};

export type AwsMarketplaceLicenseView = {
  id: string;
  productCode: string;
  licenseArn: string;
  status: "pending" | "active" | "inactive";
  planKey?: string;
  quantity?: number;
  validUntil?: number;
  checkedAt?: number;
  keys: Array<{
    id: string;
    name: string;
    keyPrefix: string;
    createdAt: number;
    revokedAt?: number;
  }>;
};

export type AwsMarketplaceRequest =
  | { operation: "stageRegistration"; registrationHash: string; browserBindingHash: string; customerAWSAccountId: string; licenseArn: string; productCode: string; customerIdentifier?: string; agreementId?: string; expiresAt: number }
  | { operation: "claimRegistration"; registrationHash: string; browserBindingHash: string; userId: string }
  | { operation: "account"; userId: string }
  | { operation: "createKey"; userId: string; licenseId: string; name: string; keyHash: string; keyPrefix: string }
  | { operation: "revokeKey"; userId: string; licenseId: string; keyId: string }
  | { operation: "beginRefresh"; productCode: string; customerAWSAccountId: string; licenseArn: string; eventId?: string; eventTime?: number }
  | { operation: "applyRefresh"; licenseId: string; revision: number; checkedAt: number; entitlements: AwsMarketplaceEntitlement[]; eventId?: string }
  | { operation: "listDue"; cursor?: string; limit: number };
