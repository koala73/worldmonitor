# CI/CD Documentation

This document describes the continuous integration and deployment setup for the sebuf protoc plugins project.

## Overview

The sebuf project uses GitHub Actions for CI/CD with the following key features:

- **Automated Testing**: Multi-platform testing across Go versions
- **Code Quality**: Linting, formatting, and coverage analysis
- **Proto Validation**: Automatic validation of protobuf files
- **Release Automation**: Automated releases with goreleaser
- **Local Testing**: Full CI pipeline testing locally with act
- **Dependency Management**: Automated updates via Dependabot

## GitHub Actions Workflows

### 1. CI Pipeline (`.github/workflows/ci.yml`)

**Triggers**: Push to main/develop, Pull Requests

**Jobs**:
- **Lint**: Code formatting and quality checks
- **Test**: Matrix testing across Go 1.20-1.22 and Linux/macOS/Windows
- **Coverage**: Coverage analysis with 85% threshold
- **Build**: Binary compilation for all plugins (go-http, go-client, ts-client, openapiv3)
- **Integration**: End-to-end testing with real proto files

**Key Features**:
- Parallel job execution for speed
- Test result artifacts for debugging
- PR comments with coverage reports
- Caching for dependencies and builds

### 2. Release Pipeline (`.github/workflows/release.yml`)

**Triggers**: Git tags (v*), Manual workflow dispatch

**Jobs**:
- **Release**: GoReleaser for multi-platform binaries
- **Docker**: Multi-arch container images
- **Announce**: Automated release announcements

**Artifacts**:
- Linux, macOS, Windows binaries (amd64, arm64, arm)
- Docker images on Docker Hub and GitHub Container Registry
- Checksums and GPG signatures
- Homebrew formula updates

### 3. Proto Validation (`.github/workflows/proto.yml`)

**Triggers**: Changes to proto files or buf configuration

**Jobs**:
- **Buf Lint**: Proto file linting and formatting
- **Breaking Changes**: Detection and PR comments
- **Compatibility**: Testing with multiple protoc versions
- **Documentation**: Auto-generated proto documentation

## Local CI Testing with Act

### Installation

```bash
# Install act
make ci-setup

# Or manually:
# macOS
brew install act

# Linux
curl -s https://raw.githubusercontent.com/nektos/act/master/install.sh | sudo bash
```

### Configuration Files

- **`.actrc`**: Act configuration with Docker image mappings
- **`.env.act`**: Environment variables for local testing
- **`.secrets`**: Secret values (never commit this file)

### Running CI Locally

```bash
# Run full CI pipeline
make ci

# Run specific workflows
make ci-lint      # Lint only
make ci-test      # Tests only
make ci-proto     # Proto validation

# List available workflows
make ci-list

# Validate workflow syntax
make ci-validate

# Clean up act artifacts
make ci-clean
```

### Troubleshooting Act

1. **Docker not running**: Ensure Docker Desktop is started
2. **Permission errors**: Run with appropriate permissions or use rootless Docker
3. **Resource limits**: Increase Docker memory/CPU limits for large builds
4. **Cache issues**: Run `make ci-clean` to reset

## Release Process

### Creating a Release

1. **Tag the release**:
   ```bash
   git tag -a v1.0.0 -m "Release v1.0.0"
   git push origin v1.0.0
   ```

2. **Automatic process**:
   - GoReleaser builds binaries for all platforms
   - Docker images are built and pushed
   - GitHub Release is created with changelog
   - Homebrew formula is updated
   - Announcement issue is created

### Manual Release (Emergency)

```bash
# Dry run to test
goreleaser release --clean --snapshot

# Actual release
GITHUB_TOKEN=xxx goreleaser release --clean
```

## Coverage Requirements

The project enforces strict coverage requirements:

- **Total Coverage**: 85% minimum
- **Package Coverage**: 80% minimum  
- **File Coverage**: 70% minimum
- **Core Generators**: 90% minimum

Coverage is checked on every PR and must pass before merging.

### Viewing Coverage Reports

```bash
# Generate local coverage report
./scripts/run_tests.sh

# View HTML report
open coverage.html

# Check coverage thresholds
go-test-coverage --config .testcoverage.yml
```

## Dependency Management

### Dependabot Configuration

Automated dependency updates for:
- Go modules (weekly)
- GitHub Actions (weekly)
- Docker base images (weekly)

Updates are grouped by type and create PRs automatically.

### Manual Updates

```bash
# Update Go dependencies
go get -u ./...
go mod tidy

# Update GitHub Actions (requires manual edit)
# Check for latest versions at:
# https://github.com/actions/checkout/releases
# https://github.com/actions/setup-go/releases
```

## Development Workflow

### Standard Development Flow

1. **Create feature branch**:
   ```bash
   git checkout -b feature/my-feature
   ```

2. **Make changes and test locally**:
   ```bash
   make test
   make lint
   make ci-test  # Test in CI environment
   ```

3. **Push and create PR**:
   ```bash
   git push origin feature/my-feature
   # Create PR on GitHub
   ```

4. **CI automatically**:
   - Runs tests on multiple platforms
   - Checks coverage requirements
   - Validates proto files
   - Comments with results

5. **Merge when green**:
   - All checks must pass
   - Coverage must meet thresholds
   - No breaking changes (unless labeled)

### Quick Commands

```bash
# Before committing
make fmt          # Format code
make lint-fix     # Fix linting issues
make test         # Run tests

# Testing CI changes
make ci           # Test full pipeline
make ci-validate  # Validate workflow syntax

# Release preparation
make build        # Build all binaries
make test         # Full test suite
git tag -a vX.Y.Z -m "Release vX.Y.Z"
```

## Monitoring and Debugging

### Build Status

- Check [Actions tab](https://github.com/SebastienMelki/sebuf/actions) for build status
- Failed builds send notifications to repo watchers
- Release failures create issues automatically

### Common Issues

1. **Test failures on Windows**:
   - Usually path separator issues
   - Check `filepath.Join()` usage

2. **Coverage drops**:
   - New code needs tests
   - Check coverage report for uncovered lines

3. **Proto breaking changes**:
   - Review carefully before merging
   - Add `breaking-change` label if intentional

4. **Release failures**:
   - Check GPG key expiration
   - Verify GITHUB_TOKEN permissions
   - Ensure tags follow v* pattern

## Security

### Secrets Management

Required secrets for full CI/CD:
- `GITHUB_TOKEN`: Automatically provided
- `DOCKER_USERNAME`: Docker Hub username
- `DOCKER_PASSWORD`: Docker Hub password
- `GPG_PRIVATE_KEY`: For signing releases
- `GPG_FINGERPRINT`: GPG key fingerprint
- `CODECOV_TOKEN`: For coverage uploads
- `HOMEBREW_TAP_GITHUB_TOKEN`: For formula updates

### Security Scanning

- Dependabot alerts for vulnerabilities
- CodeQL analysis on main branch
- Docker image scanning via registry

## Best Practices

1. **Always test locally first**: Use `make ci` before pushing
2. **Keep workflows simple**: Complex logic belongs in scripts
3. **Use matrix builds wisely**: Balance coverage vs. build time
4. **Cache aggressively**: Speeds up builds significantly
5. **Version everything**: Tag releases, version binaries
6. **Document changes**: Update CHANGELOG.md
7. **Monitor metrics**: Track build times, failure rates

## Contributing to CI/CD

When modifying CI/CD:

1. Test changes locally with act
2. Create PR with detailed description
3. Test on a fork first if major changes
4. Update this documentation
5. Consider backward compatibility

## Resources

- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [GoReleaser Documentation](https://goreleaser.com/intro/)
- [Act Documentation](https://github.com/nektos/act)
- [Buf Documentation](https://buf.build/docs)
- [Go Test Coverage](https://github.com/vladopajic/go-test-coverage)