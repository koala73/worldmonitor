import { beforeEach } from "vitest";

// Company Monitoring owner roots are synchronously coupled to entitlement
// mutations. Give every Convex test the same deterministic keyed-fence setup
// that production must provide; individual tests may still override it.
beforeEach(() => {
  process.env.DODO_IDENTITY_SIGNING_SECRET ??= "test-global-dodo-identity-signing-secret";
  process.env.COMPANY_MONITORING_OWNER_FENCE_SECRET ??=
    "test-global-company-monitoring-owner-fence-secret";
});
