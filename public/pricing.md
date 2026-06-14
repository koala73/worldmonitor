# Pricing - World Monitor

Last updated: June 13, 2026

World Monitor has a free public dashboard and paid tiers for analyst workflows, API access and organization deployments.

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
- Includes: WM Analyst chat across 30+ live services with citations, Scenario Engine, Route Explorer, personal AI digest, custom widget builder, MCP access and 39 tools under one key
- Digest cadence: Daily, twice-daily or weekly
- Delivery channels: Slack, Discord, Telegram, email and webhook

## API

- Price: $99.99/month
- Best for: Developers and teams that want programmatic access to World Monitor intelligence data
- Includes: REST API access, structured JSON, cache headers, OpenAPI docs, real-time data streams, webhook notifications and custom data exports
- Starter limit: 1,000 requests/day
- Starter webhooks: 5 webhook rules

## Enterprise

- Price: Custom
- Contact: enterprise@worldmonitor.app
- Best for: Governments, institutions, trading desks, SOCs, risk consultancies and organizations that need shared monitoring or deployment control
- Includes: Everything in Pro and API, team workspaces, SSO/MFA/RBAC, dedicated support, white-label and embeddable panels, Android TV app, SIEM/connectors, bulk export and managed deployment options
- Deployment options: Cloud, dedicated cloud tenant, on-premises or air-gapped
- Security: AES-256 encrypted notification channels, audit trail, private MCP options and organization controls

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
      "features": ["REST API", "1,000 requests/day starter limit", "webhooks", "structured JSON", "OpenAPI docs"]
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
