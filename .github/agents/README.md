# World Monitor — Agent Team Coordination

> This document defines how the 9 AI agents collaborate on continuous development, production monitoring, and updates for the World Monitor platform.

## Agent Roster

| # | Agent | File | Primary Scope |
|---|-------|------|---------------|
| 1 | **Lead Architect** | [lead-architect.md](lead-architect.md) | System design, code review, cross-agent coordination |
| 2 | **Frontend Developer** | [frontend-developer.md](frontend-developer.md) | UI components, panels, map, styling, PWA |
| 3 | **API & Backend** | [api-backend.md](api-backend.md) | Vercel edge functions, middleware, sidecar |
| 4 | **QA & Testing** | [testing-engineer.md](testing-engineer.md) | E2E, unit, visual regression, API tests |
| 5 | **Documentation Writer** | [documentation-writer.md](documentation-writer.md) | All docs, CHANGELOG, inline comments |
| 6 | **DevOps & CI/CD** | [devops-cicd.md](devops-cicd.md) | Build pipeline, deploy, infrastructure |
| 7 | **Security Analyst** | [security-analyst.md](security-analyst.md) | AppSec, API keys, CSP, vulnerability mgmt |
| 8 | **Data & Intelligence** | [data-intelligence.md](data-intelligence.md) | Data sources, algorithms, ML, entity registry |
| 9 | **Production Ops** | [production-ops.md](production-ops.md) | Uptime, incidents, performance, monitoring |
| 10 | **i18n Specialist** | [i18n-specialist.md](i18n-specialist.md) | Translations, RTL, locale formatting |

---

## Development Workflows

### Workflow 1: New Feature Development

```
┌─────────────────────────────────────────────────────────────────┐
│                    FEATURE REQUEST                               │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
          ┌────────────────────────┐
          │   1. Lead Architect    │  Design, scope, assign
          │   - Architecture spec  │
          │   - Variant impact     │
          │   - Agent assignments  │
          └──────────┬─────────────┘
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
  ┌───────────┐ ┌──────────┐ ┌──────────────┐
  │ Frontend  │ │ API/     │ │ Data/Intel    │
  │ Developer │ │ Backend  │ │ Specialist   │
  │           │ │          │ │              │
  │ Component │ │ Endpoint │ │ Data source  │
  │ + Panel   │ │ + Cache  │ │ + Algorithm  │
  └─────┬─────┘ └────┬─────┘ └──────┬───────┘
        │            │              │
        └────────────┼──────────────┘
                     ▼
          ┌────────────────────────┐
          │  2. i18n Specialist    │  Add translation keys
          │  - All 14 locales      │
          │  - RTL if applicable   │
          └──────────┬─────────────┘
                     ▼
          ┌────────────────────────┐
          │  3. Testing Engineer   │  Write tests
          │  - E2E for new panel   │
          │  - API tests           │
          │  - Visual regression   │
          └──────────┬─────────────┘
                     ▼
          ┌────────────────────────┐
          │  4. Security Analyst   │  Security review
          │  - Input sanitization  │
          │  - API key handling    │
          │  - CORS/CSP            │
          └──────────┬─────────────┘
                     ▼
          ┌────────────────────────┐
          │  5. Documentation      │  Update docs
          │  - Component docs      │
          │  - API reference       │
          │  - CHANGELOG           │
          └──────────┬─────────────┘
                     ▼
          ┌────────────────────────┐
          │  6. Lead Architect     │  Final review
          │  - Architecture check  │
          │  - Quality gates       │
          │  - Merge approval      │
          └──────────┬─────────────┘
                     ▼
          ┌────────────────────────┐
          │  7. DevOps Engineer    │  Deploy
          │  - Build all variants  │
          │  - Deploy to preview   │
          │  - Promote to prod     │
          └──────────┬─────────────┘
                     ▼
          ┌────────────────────────┐
          │  8. Production Ops     │  Validate
          │  - Post-deploy checks  │
          │  - Monitor for errors  │
          │  - Confirm stable      │
          └────────────────────────┘
```

### Workflow 2: Bug Fix

```
Bug Report
    │
    ▼
Production Ops ──► Classify severity (SEV-1 to SEV-4)
    │
    ▼
Lead Architect ──► Assign to appropriate agent
    │
    ├── Frontend bug    ──► Frontend Developer
    ├── API bug         ──► API Backend Developer
    ├── Data issue      ──► Data Intelligence Specialist
    ├── Security vuln   ──► Security Analyst (PRIORITY)
    ├── i18n bug        ──► i18n Specialist
    └── Build/deploy    ──► DevOps Engineer
    │
    ▼
Assigned Agent ──► Fix + unit test
    │
    ▼
Testing Engineer ──► Verify fix, add regression test
    │
    ▼
Lead Architect ──► Review + approve
    │
    ▼
DevOps Engineer ──► Deploy
    │
    ▼
Production Ops ──► Validate fix in production
    │
    ▼
Documentation Writer ──► Update CHANGELOG
```

### Workflow 3: New Data Source Integration

```
New Data Source Request
    │
    ▼
Data Intelligence ──► Research API, design data model
    │
    ├── Define TypeScript interfaces (src/types/index.ts)
    ├── Design caching strategy (TTL, Redis keys)
    └── Design signal integration (if produces signals)
    │
    ▼
API Backend ──► Build endpoint
    │
    ├── Create api/new-source.js
    ├── Add CORS, cache, rate limiting
    ├── Add to sidecar for desktop parity
    └── Set env vars in Vercel
    │
    ▼
Data Intelligence ──► Build service
    │
    ├── Create src/services/new-source.ts
    ├── Implement circuit breaker
    ├── Register in signal aggregator (if applicable)
    └── Add to data freshness tracker
    │
    ▼
Frontend Developer ──► Build UI
    │
    ├── Create new panel component (if needed)
    ├── Add map layer (if geospatial)
    └── Wire to App.ts refresh cycle
    │
    ▼
[Continue with i18n → Testing → Security → Docs → Deploy → Monitor]
```

### Workflow 4: Production Incident Response

```
Alert Detected (Sentry / Health Check / User Report)
    │
    ▼
Production Ops
    │
    ├── SEV-1/SEV-2: IMMEDIATELY
    │   ├── Assess: is rollback needed?
    │   ├── If yes → DevOps: instant Vercel rollback
    │   ├── Notify Lead Architect
    │   └── Begin root cause analysis
    │
    ├── SEV-3: Within 4 hours
    │   ├── Identify affected component/service
    │   ├── Assign to appropriate agent
    │   └── Monitor degradation impact
    │
    └── SEV-4: Within 24 hours
        ├── Log issue
        └── Assign to sprint backlog
    │
    ▼
Root Cause Fix ──► Normal Bug Fix Workflow
    │
    ▼
Production Ops ──► Post-mortem document
    │
    ├── Timeline of events
    ├── Root cause
    ├── Remediation steps
    ├── Prevention measures
    └── Action items for agents
```

### Workflow 5: Dependency Update / Security Patch

```
Dependabot Alert / npm audit finding
    │
    ▼
Security Analyst ──► Assess vulnerability
    │
    ├── Critical/High: Fast-track
    │   ├── DevOps: Update dependency
    │   ├── Testing: Run full suite
    │   ├── DevOps: Deploy immediately
    │   └── Production Ops: Monitor
    │
    └── Medium/Low: Standard flow
        ├── DevOps: Update in next release
        └── Testing: Include in regular test run
```

### Workflow 6: Release Cycle

```
Release Planning
    │
    ▼
Lead Architect ──► Define release scope
    │
    ├── Verify all features complete
    ├── Verify all tests passing
    └── Verify documentation updated
    │
    ▼
DevOps Engineer ──► Prepare release
    │
    ├── Version bump (package.json, tauri.conf.json)
    ├── Build all 3 web variants
    ├── Build desktop apps (if desktop release)
    └── Code sign desktop installers
    │
    ▼
Testing Engineer ──► Release QA
    │
    ├── Full E2E suite (all variants)
    ├── Visual regression check
    ├── API endpoint validation
    ├── Desktop smoke test (if applicable)
    └── Performance benchmark
    │
    ▼
Security Analyst ──► Release security check
    │
    ├── npm audit clean
    ├── No leaked API keys
    ├── CSP headers correct
    └── No new XSS vectors
    │
    ▼
Documentation Writer ──► Release docs
    │
    ├── CHANGELOG.md updated
    ├── Version references updated
    └── Migration guide (if breaking changes)
    │
    ▼
DevOps Engineer ──► Deploy to production
    │
    ├── Deploy all 3 variants
    ├── Upload desktop installers to GitHub Releases
    └── Update download redirect (api/download.js)
    │
    ▼
Production Ops ──► Post-release monitoring
    │
    ├── Post-deploy validation checklist
    ├── Monitor Sentry for 24 hours
    ├── Check Web Vitals metrics
    └── Confirm cache hit rates normal
    │
    ▼
i18n Specialist ──► Post-release audit
    │
    └── Verify all new keys translated in all locales
```

---

## Continuous Monitoring Loops

### Daily Operations (Production Ops)
```
06:00  Health check all variants
06:05  Review Sentry overnight errors
06:15  Check external API status
06:30  Review cache telemetry
07:00  Report: daily ops summary
```

### Weekly Maintenance (All Agents)
```
Monday:    Security Analyst    → npm audit, CORS review
Tuesday:   Data Intelligence   → Feed health check, source availability
Wednesday: Testing Engineer    → Flaky test review, coverage gaps
Thursday:  DevOps Engineer     → Dependency updates, build optimization
Friday:    Documentation       → Docs sync check, stale reference audit
```

### Monthly Reviews
```
Week 1:  Lead Architect      → Architecture debt review, refactoring priorities
Week 2:  Production Ops      → Performance trends, capacity planning
Week 3:  Security Analyst    → Security posture review, penetration testing
Week 4:  i18n Specialist     → Translation completeness audit, quality review
```

---

## Shared Conventions

### Branch Naming
```
feat/{agent-initials}-{description}     # New features
fix/{agent-initials}-{description}      # Bug fixes
docs/{description}                       # Documentation only
security/{description}                   # Security patches
refactor/{description}                   # Code refactoring
perf/{description}                       # Performance improvements
i18n/{locale}-{description}             # Internationalization
```

Agent initials: `la` (Lead Architect), `fd` (Frontend), `ab` (API Backend), `te` (Testing), `dw` (Docs), `do` (DevOps), `sa` (Security), `di` (Data Intel), `po` (Prod Ops), `i8` (i18n)

### Commit Message Format
```
{type}({scope}): {description}

Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore
Scope: panel, api, service, config, map, i18n, desktop, build, deploy
```

### File Ownership Matrix
| Path | Primary Agent | Review By |
|------|--------------|-----------|
| `src/components/` | Frontend Developer | Lead Architect |
| `src/services/` | Data Intelligence / Frontend | Lead Architect |
| `src/config/` | Data Intelligence | Lead Architect |
| `src/types/` | Lead Architect | All |
| `src/utils/` | Frontend Developer | Security Analyst |
| `src/styles/` | Frontend Developer | i18n Specialist (RTL) |
| `src/locales/` | i18n Specialist | Documentation Writer |
| `src/workers/` | Data Intelligence | Lead Architect |
| `api/` | API Backend | Security Analyst |
| `api/_*.js` | API Backend | Security Analyst |
| `e2e/` | Testing Engineer | Frontend Developer |
| `tests/` | Testing Engineer | Data Intelligence |
| `docs/` | Documentation Writer | Lead Architect |
| `deploy/` | DevOps Engineer | Security Analyst |
| `scripts/` | DevOps Engineer | Lead Architect |
| `src-tauri/` | DevOps + Frontend | Lead Architect + Security |
| `vite.config.ts` | DevOps Engineer | Lead Architect |
| `package.json` | DevOps Engineer | Lead Architect |
| `.github/` | DevOps Engineer | Lead Architect |

### Communication Protocol
When an agent needs input from another agent:
1. **State the question clearly** with file references
2. **Provide context**: what you've already tried, what you need decided
3. **Propose a default**: suggest the most likely answer so the other agent can confirm
4. **Include the variant scope**: which of the 3 variants is affected

### Conflict Resolution
When two agents modify the same file:
1. The agent touching `src/types/index.ts` goes first (type definitions drive everything)
2. Config changes (`src/config/`) go before component changes
3. Service changes go before component changes
4. The Lead Architect resolves any remaining conflicts
5. Both agents must re-verify their changes after merge

---

## Getting Started with the Agent Team

### For a New Agent Joining the Team
1. Read your role-specific agent file in `.github/agents/`
2. Read this coordination document
3. Read `docs/todo_docs.md` for documentation tasks
4. Read `README.md` for project overview
5. Read `src/types/index.ts` for data model understanding
6. Explore `src/config/variant.ts` to understand the variant system
7. Run `npm run build` to verify the project builds
8. Run `npm run test:e2e` to verify tests pass

### For the Human Operator
- **To request a feature**: Describe the feature and tag `@lead-architect`
- **To report a bug**: Describe the issue and tag `@production-ops`
- **To request docs**: Describe what's needed and tag `@documentation-writer`
- **To escalate security**: Describe the concern and tag `@security-analyst`
- **To override**: Any agent decision can be overridden by the human operator
