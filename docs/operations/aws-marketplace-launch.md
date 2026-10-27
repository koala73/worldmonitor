# AWS Marketplace launch checks

The API and MCP implementation proves local request behavior. It does not prove seller account readiness, legal terms, data rights, or a deployed AWS integration. Complete these checks before making the listing public or accepting live buyers.

## Service and customer path

- Confirm the AWS Marketplace product code, dimension-to-plan mapping, seller credentials, registration URL, and notification/SQS permissions in the target deployment. Use a test purchase to verify `ResolveCustomer`, entitlement refresh, claim, key creation, one API request, and one MCP call.
- Capture actual seller `License Updated - Manufacturer` and `License Deprovisioned - Manufacturer` events during the test purchase. Verify that each event's `detail.license.arn` exactly matches the `LicenseArn` returned by `ResolveCustomer`, and that active `GetEntitlements` rows carry that same ARN. Verify that the worker accepts and processes both events. The [published event examples](https://docs.aws.amazon.com/marketplace/latest/userguide/notifications-eventbridge.html) omit parts of the ARN required by the [ResolveCustomer response contract](https://docs.aws.amazon.com/marketplace/latest/APIReference/API_marketplace-metering_ResolveCustomer.html); do not infer or rewrite a license identifier from those examples.
- Check that a suspended, expired, or canceled agreement blocks both API and MCP. Check that an AWS verification outage returns a retryable 503 and does not grant an old entitlement. Measure the 5-minute reconciliation and 15-minute proof limits in the deployed environment.
- Confirm daily REST enforcement in the target deployment. `API_RATE_LIMIT_ENFORCE` has been off in the prior production runbook; a local catalog value does not prove that the REST cap rejects requests. Confirm how REST and MCP counters combine before advertising a shared enforced ceiling.
- Verify the buyer can return through AWS **Manage subscriptions**, sign in, claim once, create and revoke a key, and recover an expired setup link. Confirm no key or registration secret appears in logs, URLs, analytics, or support tickets.
- Configure a support owner, escalation path, and incident response for license verification, key compromise, and billing disputes. AWS manages the buyer agreement and billing; WorldMonitor support handles the app and keys.

## Seller and policy acceptance

- Confirm seller profile, tax information, payout setup, product support contacts, listing metadata, pricing dimensions, and EULA with the authorized seller team.
- Have the owner confirm customer deletion, license unlinking, key revocation, and retained audit data meet the published privacy terms. Check that security audit records are access protected and retained for at least one year where the Marketplace/security commitment requires it.
- Confirm redistribution and use rights for every data source exposed by the API and MCP offer, including derived and third-party feeds. Check any regional or customer restrictions against the listing and EULA.

Record the test agreement, deployment identity, observed responses, and policy approvals in the release evidence. Passing repository tests is not a substitute for these external checks.
