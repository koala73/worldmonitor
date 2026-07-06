# Support & Contact - World Monitor

Last updated: July 5, 2026

How to reach World Monitor, by concern. Human-readable version: https://www.worldmonitor.app/docs/support

## Channels

| Concern | Channel | Notes |
| --- | --- | --- |
| General support, account or billing issues | support@worldmonitor.app | Primary support channel for all plans |
| Enterprise, sales, custom quotas | enterprise@worldmonitor.app | Custom pricing, deployments, higher API limits |
| Bug reports & feature requests | https://github.com/koala73/worldmonitor/issues | Public open-source repository |
| Community & quick questions | https://discord.gg/re63kWKxaz | Community Discord |
| Service status & incidents | https://status.worldmonitor.app | Email subscription available on the page |
| In-app contact form | Form on https://worldmonitor.app/pro | Submits `POST /api/leads/v1/submit-contact`; Turnstile-protected, intended for humans in a browser — agents should email support@ instead |

## Response Expectations

- Free and Pro: best-effort support via email, GitHub and Discord. No formal SLA.
- API: best-effort support via email; include your key prefix (never the full key) and request IDs.
- Enterprise: dedicated support with committed response times, agreed per contract — contact enterprise@worldmonitor.app.

## Common Self-Serve Answers

- API key rotation or limit increases: see https://www.worldmonitor.app/docs/usage-auth and https://www.worldmonitor.app/docs/usage-rate-limits, or email support@worldmonitor.app.
- Pricing and plans: https://worldmonitor.app/pricing.md (markdown) or `GET https://www.worldmonitor.app/api/product-catalog` (JSON, public).
- Billing portal (invoices, cancel/renew): sign in at https://worldmonitor.app/pro and open the customer portal.
- Security reports: see https://www.worldmonitor.app/.well-known/security.txt

## Machine-Readable Summary

```json
{
  "product": "World Monitor",
  "support_email": "support@worldmonitor.app",
  "enterprise_email": "enterprise@worldmonitor.app",
  "issues_url": "https://github.com/koala73/worldmonitor/issues",
  "community_url": "https://discord.gg/re63kWKxaz",
  "status_url": "https://status.worldmonitor.app",
  "security_txt": "https://www.worldmonitor.app/.well-known/security.txt",
  "sla": { "free": "best-effort", "pro": "best-effort", "api": "best-effort", "enterprise": "contracted" }
}
```
