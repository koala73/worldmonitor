# Security Policy

## Supported Versions

The following versions of sebuf are currently being supported with security updates:

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

We take the security of sebuf seriously. If you discover a security vulnerability, please follow these steps:

### How to Report

1. **DO NOT** create a public GitHub issue for security vulnerabilities
2. Email your findings to [sebastienmelki@gmail.com] or use GitHub's private vulnerability reporting:
   - Go to the [Security tab](https://github.com/SebastienMelki/sebuf/security)
   - Click "Report a vulnerability"
   - Provide detailed information about the vulnerability

### What to Include

When reporting a vulnerability, please include:

- Description of the vulnerability
- Steps to reproduce the issue
- Potential impact
- Any proof-of-concept code
- Your suggested fix (if any)

### Response Timeline

- **Initial Response**: Within 48 hours of receipt
- **Status Update**: Within 5 business days
- **Resolution Target**: Critical vulnerabilities within 7 days, others within 30 days

### Responsible Disclosure

We kindly ask that you:

- Allow us reasonable time to address the issue before public disclosure
- Avoid exploiting the vulnerability beyond what's necessary for verification
- Not access or modify other users' data

### Recognition

We appreciate your efforts in keeping sebuf secure. Contributors who report valid security issues will be:

- Acknowledged in our security advisories (unless you prefer to remain anonymous)
- Added to our Security Hall of Fame

## Security Best Practices

When using sebuf in production:

### API Security
- Always use HTTPS in production
- Implement proper authentication (the X-API-Key header validation is just an example)
- Use rate limiting to prevent abuse
- Validate and sanitize all inputs using buf.validate annotations

### Header Validation
- Define required headers at the service level for consistency
- Use format validators (UUID, email, etc.) for structured data
- Never log sensitive header values

### Generated Code
- Keep dependencies up to date
- Review generated code before deploying to production
- Use the validation features to prevent injection attacks

### Protobuf Security
- Avoid recursive message definitions that could cause stack overflow
- Set reasonable size limits for repeated fields
- Use field validation to prevent malicious input

## Security Features

sebuf includes several built-in security features:

- **Automatic input validation** via protovalidate/buf.validate
- **Header validation** with type and format checking
- **Safe JSON marshaling** using protojson
- **Type-safe code generation** preventing common vulnerabilities

## Contact

For security concerns, contact:
- Email: [security@sebuf.dev]
- GitHub Security Advisories: [Report a vulnerability](https://github.com/SebastienMelki/sebuf/security/advisories/new)

Thank you for helping keep sebuf and its users safe!