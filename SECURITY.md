# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| main    | :white_check_mark: |

Only the latest version on the `main` branch is actively maintained and receives security updates.

## Reporting a Vulnerability

**Please do NOT report security vulnerabilities through public GitHub issues.**

If you discover a security vulnerability in World Monitor, please report it responsibly:

1. **GitHub Private Vulnerability Reporting**: Use [GitHub's private vulnerability reporting](https://github.com/koala73/worldmonitor/security/advisories/new) to submit your report directly through the repository.

2. **Direct Contact**: Alternatively, reach out to the repository owner [@koala73](https://github.com/koala73) directly through GitHub.

### What to Include

- A description of the vulnerability and its potential impact
- Steps to reproduce the issue
- Affected components (edge functions, client-side code, data layers, etc.)
- Any potential fixes or mitigations you've identified

### Response Timeline

- **Acknowledgment**: Within 48 hours of your report
- **Initial Assessment**: Within 1 week
- **Fix/Patch**: Depending on severity, critical issues will be prioritized

### What to Expect

- You will receive an acknowledgment of your report
- We will work with you to understand and validate the issue
- We will keep you informed of progress toward a fix
- Credit will be given to reporters in the fix commit (unless you prefer anonymity)

## Security Considerations

World Monitor is a client-side intelligence dashboard that aggregates publicly available data. Here are the key security areas:

### API Keys & Secrets

- All API keys are stored server-side in Vercel Edge Functions
- No API keys should ever be committed to the repository
- Environment variables (`.env.local`) are gitignored
- The RSS proxy uses domain allowlisting to prevent SSRF

### Edge Functions & Sebuf Handlers

- All 17 domain APIs are served through Sebuf (a Proto-first RPC framework) via Vercel Edge Functions
- Edge functions and handlers should validate/sanitize all input
- CORS headers are configured per-function
- Rate limiting and circuit breakers protect against abuse

### Client-Side Security

- No sensitive data is stored in localStorage or sessionStorage
- External content (RSS feeds, news) is sanitized before rendering
- Map data layers use trusted, vetted data sources

### Data Sources

- World Monitor aggregates publicly available OSINT data
- No classified or restricted data sources are used
- State-affiliated sources are flagged with propaganda risk ratings
- All data is consumed read-only — the platform does not modify upstream sources

## Scope

The following are **in scope** for security reports:

- Vulnerabilities in the World Monitor codebase
- Edge function security issues (SSRF, injection, auth bypass)
- XSS or content injection through RSS feeds or external data
- API key exposure or secret leakage
- Dependency vulnerabilities with a viable attack vector

The following are **out of scope**:

- Vulnerabilities in third-party services we consume (report to the upstream provider)
- Social engineering attacks
- Denial of service attacks
- Issues in forked copies of the repository
- Security issues in user-provided environment configurations

## Best Practices for Contributors

- Never commit API keys, tokens, or secrets
- Use environment variables for all sensitive configuration
- Sanitize external input in edge functions
- Keep dependencies updated — run `npm audit` regularly
- Follow the principle of least privilege for API access

---

Thank you for helping keep World Monitor and its users safe! 🔒
