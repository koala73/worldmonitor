# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| main    | :white_check_mark: |

Only the latest version on the `main` branch is actively maintained and receives security updates.

## Reporting a Vulnerability

**Please do NOT report security vulnerabilities through public GitHub issues.**

If you discover a security vulnerability in World Monitor macOS, please report it responsibly:

1. **GitHub Private Vulnerability Reporting**: Use [GitHub's private vulnerability reporting](https://github.com/bradleybond512/worldmonitor-macos/security/advisories/new) to submit your report directly through the repository.

2. **Direct Contact**: Alternatively, reach out to the repository owner [@bradleybond512](https://github.com/bradleybond512) directly through GitHub.

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

- **Web deployment**: API keys are stored server-side in Vercel Edge Functions
- **Desktop runtime**: API keys are stored in the OS keychain (macOS Keychain / Windows Credential Manager) via a consolidated vault entry, never on disk in plaintext
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
- Content Security Policy restricts script-src to `'self'` (no unsafe-inline/eval)

### Desktop Runtime Security (Tauri)

- **IPC origin validation**: Sensitive Tauri commands (secrets, cache, token) are gated to trusted windows only; external-origin windows (e.g., YouTube login) are blocked
- **DevTools**: Disabled in production builds; gated behind an opt-in Cargo feature for development
- **Sidecar authentication**: A per-session CSPRNG token (`LOCAL_API_TOKEN`) authenticates all renderer-to-sidecar requests, preventing other local processes from accessing the API
- **Capability isolation**: The YouTube login window runs under a restricted capability with no access to secret or cache IPC commands
- **Fetch patch trust boundary**: The global fetch interceptor injects the sidecar token with a 5-minute TTL; the renderer is the intended client — if renderer integrity is compromised, Tauri IPC provides strictly more access than the fetch patch

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
- Tauri IPC command privilege escalation or capability bypass
- Sidecar authentication bypass or token leakage
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
