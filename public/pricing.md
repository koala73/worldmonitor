# Pricing - World Monitor

Last updated: July 6, 2026

World Monitor has a free public dashboard and paid tiers for analyst workflows, API access and organization deployments.

Live tier/price/product-ID data (JSON): `GET https://www.worldmonitor.app/api/product-catalog` — public, no key required. Send a descriptive `User-Agent` (for example `mytool/1.0 (+https://yoursite.example)`); default HTTP-library user agents may be challenged by the edge firewall.

## Free

- Price: $0/month
- Signup required: No
- Best for: Public situational awareness, OSINT research, market/geopolitical context, news monitoring
- Includes: 56 map layers, 500+ curated feeds, country briefs, hotspots, instability scores, chokepoints, cables, cascade analysis, breaking alert pipeline and watchlists
- Limits: Free dashboard refresh cadence is typically 5-15 minutes; advanced analyst, digest, API and team workflows require paid plans

## Pro

- Price: $39.99/month
- Annual price: $399.99/year
- Annual savings: 2 months free versus monthly billing
- Best for: Investors, analysts, researchers, traders and operators who need the decision layer on top of the free dashboard
- Includes: WM Analyst chat across 30+ live services with citations, Scenario Engine, Route Explorer, personal AI digest, custom widget builder, MCP access and 40 tools under one key
- Digest cadence: Daily, twice-daily or weekly
- Delivery channels: Slack, Discord, Telegram, email and webhook

## API

- Price: $99.99/month
- Annual price: $999/year
- Annual savings: about 17 percent versus monthly billing
- Best for: Developers and teams that want programmatic access to World Monitor intelligence data
- Includes: REST API access, structured JSON, cache headers, OpenAPI docs, real-time data streams, webhook notifications and custom data exports
- Starter limit: 1,000 requests/day
- Starter webhooks: 5 webhook rules

## API Business

- Price: $249.99/month
- Best for: Teams with high-volume programmatic workloads that outgrow the Starter quota
- Includes: Everything in API Starter and priority support
- Limits: 300 requests/minute, 10,000 requests/day
- Upgrading from Starter: manage the switch from the billing portal (prorated immediately); new customers can subscribe directly at https://worldmonitor.app/pro

## Enterprise

- Price: Custom
- Contact: enterprise@worldmonitor.app
- Best for: Governments, institutions, trading desks, SOCs, risk consultancies and organizations that need shared monitoring or deployment control
- Includes: Everything in Pro and API, team workspaces, SSO/MFA/RBAC, dedicated support, white-label and embeddable panels, Android TV app, SIEM/connectors, bulk export and managed deployment options
- Deployment options: Cloud, dedicated cloud tenant, on-premises or air-gapped
- Security: AES-256 encrypted notification channels, audit trail, private MCP options and organization controls

## Limits & Overage

- Rate limits are hard limits by default: exceeding a plan quota returns HTTP `429` with a `Retry-After` header and `X-RateLimit-*` headers on API responses. Usage above the quota is rejected — never silently charged; if opt-in metered overage is introduced for API plans it will be documented here first.
- Per-endpoint request budgets are documented at https://www.worldmonitor.app/docs/usage-rate-limits (also fetchable as markdown at https://www.worldmonitor.app/docs/usage-rate-limits.md).
- Need a higher limit? Upgrade at https://worldmonitor.app/pro or contact enterprise@worldmonitor.app for custom quotas.

## Machine-Readable Summary

```json
{
  "product": "World Monitor",
  "url": "https://www.worldmonitor.app/",
  "pricing_url": "https://www.worldmonitor.app/pro#pricing",
  "plans": [
    {
      "name": "Free",
      "price_usd_monthly": 0,
      "signup_required": false,
      "features": ["56 map layers", "500+ feeds", "country briefs", "chokepoints", "instability scores", "watchlists"]
    },
    {
      "name": "Pro",
      "price_usd_monthly": 39.99,
      "price_usd_yearly": 399.99,
      "features": ["WM Analyst", "Scenario Engine", "Route Explorer", "AI digest", "custom widget builder", "MCP"]
    },
    {
      "name": "API",
      "price_usd_monthly": 99.99,
      "price_usd_yearly": 999,
      "features": ["REST API", "1,000 requests/day starter limit", "webhooks", "structured JSON", "OpenAPI docs"]
    },
    {
      "name": "API Business",
      "price_usd_monthly": 249.99,
      "features": ["Everything in API Starter", "300 requests/minute", "10,000 requests/day", "priority support"]
    },
    {
      "name": "Enterprise",
      "price": "Custom",
      "contact": "enterprise@worldmonitor.app",
      "features": ["SSO/MFA/RBAC", "team workspaces", "white-label", "on-premises", "air-gapped", "dedicated support"]
    }
  ]
}
```
