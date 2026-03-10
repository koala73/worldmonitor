# Contributing to sebuf

> Help us build the future of protobuf development for HTTP APIs

We're thrilled that you're interested in contributing to sebuf! This guide will help you get started and ensure your contributions can be smoothly integrated.

## 🌟 Ways to Contribute

- **🐛 Bug Reports** - Found something broken? Let us know!
- **💡 Feature Requests** - Have ideas for new functionality?
- **📖 Documentation** - Help improve our docs and examples
- **🔧 Code Contributions** - Fix bugs or implement new features
- **🧪 Testing** - Add test cases or improve test coverage
- **💬 Community Support** - Help others in discussions and issues

## 🚀 Quick Start for Contributors

### 1. Development Environment Setup

```bash
# Fork and clone the repository
git clone https://github.com/yourusername/sebuf.git
cd sebuf

# Install dependencies
go mod download

# Install development tools
make install

# Run tests to ensure everything works
make test
```

### 2. Development Workflow

```bash
# Create a feature branch
git checkout -b feature/your-feature-name

# Make your changes
# ... edit code ...

# Run tests and checks
make test
make lint

# Generate any necessary code
make generate

# Commit your changes
git add .
git commit -m "feat: add your feature description"

# Push and create a pull request
git push origin feature/your-feature-name
```

## 📋 Development Guidelines

### Code Style

We follow standard Go conventions with a few sebuf-specific guidelines:

**Go Code:**
```go
// ✅ Good: Clear, descriptive function names
func GenerateHTTPHandlers(service *protogen.Service) error {
    // Function body
}

// ✅ Good: Proper error handling
if err := generateFile(file); err != nil {
    return fmt.Errorf("failed to generate file %s: %w", file.Name, err)
}

// ✅ Good: Comprehensive comments for exported functions
// GenerateHelpers generates convenience constructor functions for protobuf 
// messages containing oneof fields. It processes all messages in the file
// and creates helpers for each oneof field that contains a message type.
func GenerateHelpers(plugin *protogen.Plugin, file *protogen.File) {
    // Implementation
}
```

**Protobuf Definitions:**
```protobuf
// ✅ Good: Clear service and method documentation
// UserService provides user management capabilities including
// authentication, profile management, and access control.
service UserService {
  // CreateUser registers a new user in the system.
  // Validates input, ensures email uniqueness, and sends welcome email.
  rpc CreateUser(CreateUserRequest) returns (User);
}

// ✅ Good: Descriptive field comments
message User {
  // Unique identifier for the user (UUID format)
  string id = 1;
  
  // User's email address (must be unique across the system)
  string email = 2;
}
```

### Testing Requirements

All contributions must include appropriate tests:

**Unit Tests:**
```go
func TestLowerFirst(t *testing.T) {
    tests := []struct {
        name     string
        input    string
        expected string
    }{
        {"empty string", "", ""},
        {"single char", "A", "a"},
        {"camelCase", "CamelCase", "camelCase"},
        {"already lower", "lowercase", "lowercase"},
    }
    
    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            result := lowerFirst(tt.input)
            if result != tt.expected {
                t.Errorf("lowerFirst(%q) = %q, want %q", tt.input, result, tt.expected)
            }
        })
    }
}
```

**Golden File Tests** (for code generation):
```go
func TestCodeGeneration(t *testing.T) {
    // Golden file tests ensure generated code doesn't change unexpectedly
    // When intentionally changing output, run: UPDATE_GOLDEN=1 go test
    
    goldenFile := "testdata/golden/expected_output.pb.go"
    actualOutput := generateCode(inputProto)
    
    if os.Getenv("UPDATE_GOLDEN") == "1" {
        err := os.WriteFile(goldenFile, actualOutput, 0644)
        require.NoError(t, err)
        return
    }
    
    expectedOutput, err := os.ReadFile(goldenFile)
    require.NoError(t, err)
    require.Equal(t, string(expectedOutput), string(actualOutput))
}
```

### Documentation Standards

**Code Documentation:**
- All exported functions must have comprehensive comments
- Include examples for complex functions
- Document error conditions and return values

**README and Guides:**
- Use clear, action-oriented headings
- Include working code examples
- Provide troubleshooting sections
- Test all examples before submitting

## 🏗️ Project Architecture

Understanding the project structure helps you contribute effectively:

### Repository Structure

```
sebuf/
├── cmd/                           # Command-line tools
│   ├── protoc-gen-go-http/           # HTTP handler generator
│   ├── protoc-gen-go-client/         # Go HTTP client generator
│   ├── protoc-gen-ts-client/         # TypeScript HTTP client generator
│   ├── protoc-gen-ts-server/         # TypeScript HTTP server generator
│   └── protoc-gen-openapiv3/         # OpenAPI spec generator
├── internal/                      # Internal packages
│   ├── httpgen/                      # HTTP generation logic
│   ├── clientgen/                    # Go HTTP client generation logic
│   ├── tscommon/                     # Shared TypeScript type mapping
│   ├── tsclientgen/                  # TypeScript HTTP client generation logic
│   ├── tsservergen/                  # TypeScript HTTP server generation logic
│   └── openapiv3/                    # OpenAPI generation logic
├── proto/                         # Protobuf definitions
├── http/                          # Generated HTTP annotations
├── docs/                          # Documentation
├── scripts/                       # Build and test scripts
└── examples/                      # Complete examples
```

### Core Components

**1. Plugin Entry Points (`cmd/*/main.go`)**
- Minimal orchestration
- Reads CodeGeneratorRequest from stdin
- Delegates to internal packages
- Writes CodeGeneratorResponse to stdout

**2. Code Generation Logic (`internal/*/`)**
- Core generation algorithms
- Type system handling
- Template generation
- File output management

**3. Testing Infrastructure**
- Golden file testing for regression detection
- Unit tests for individual functions
- Integration tests for complete workflows

## 🐛 Bug Reports

### Before Submitting a Bug Report

1. **Search existing issues** - Your bug might already be reported
2. **Try latest version** - Update to the latest release
3. **Minimal reproduction** - Create the smallest possible example
4. **Check documentation** - Ensure you're using the tools correctly

### Bug Report Template

```markdown
**Describe the Bug**
A clear description of what the bug is.

**To Reproduce**
Steps to reproduce the behavior:
1. Create protobuf file with '...'
2. Run command '...'
3. See error

**Expected Behavior**
What you expected to happen.

**Actual Behavior**
What actually happened, including full error messages.

**Environment**
- OS: [e.g., macOS 14.1]
- Go version: [e.g., 1.21.3]
- sebuf version: [e.g., v0.1.0]
- protoc version: [e.g., 3.21.12]

**Protobuf Definition**
```protobuf
// Include your .proto file content
```

**Generated Code** (if applicable)
```go
// Include relevant generated code
```

**Additional Context**
Any other context about the problem.
```

## 💡 Feature Requests

### Before Submitting a Feature Request

1. **Check the roadmap** - Feature might already be planned
2. **Search discussions** - Someone might have requested it already
3. **Consider scope** - Is this a core feature or plugin material?
4. **Think about backwards compatibility** - How does this affect existing users?

### Feature Request Template

```markdown
**Is your feature request related to a problem?**
A clear description of what the problem is. Ex. I'm frustrated when [...]

**Describe the solution you'd like**
A clear description of what you want to happen.

**Describe alternatives you've considered**
Other solutions or workarounds you've tried.

**Use Cases**
Concrete examples of how this feature would be used.

**Additional Context**
Any other context, screenshots, or examples.
```

## 🔧 Code Contributions

### Types of Contributions We Welcome

**🟢 Great First Issues:**
- Documentation improvements
- Additional test cases
- Example projects
- Bug fixes with clear reproduction steps

**🟡 Intermediate Contributions:**
- New code generation features
- Performance improvements
- Additional HTTP framework integrations
- Enhanced error messages

**🔴 Advanced Contributions:**
- New plugin architectures
- Breaking changes with migration paths
- Performance-critical optimizations
- Major new functionality

### Pull Request Process

1. **Fork and Branch**
   ```bash
   git checkout -b feature/descriptive-name
   ```

2. **Make Your Changes**
   - Follow the style guide
   - Add tests for new functionality
   - Update documentation as needed

3. **Test Your Changes**
   ```bash
   # Run the full test suite
   make test
   
   # Test with coverage
   make test-coverage
   
   # Run linting
   make lint
   
   # Test examples
   make test-examples
   ```

4. **Commit with Conventional Commits**
   ```bash
   git commit -m "feat: add support for custom HTTP headers"
   git commit -m "fix: handle empty oneof fields correctly"
   git commit -m "docs: improve getting started guide"
   ```

5. **Submit Pull Request**
   - Clear title and description
   - Reference related issues
   - Include screenshots/examples if relevant

### Pull Request Template

```markdown
**Description**
Brief description of changes and why they're needed.

**Type of Change**
- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update
- [ ] Performance improvement
- [ ] Code refactoring

**How Has This Been Tested?**
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] Golden file tests updated (if applicable)
- [ ] Manual testing performed

**Checklist**
- [ ] My code follows the project's style guidelines
- [ ] I have performed a self-review of my code
- [ ] I have commented my code, particularly in hard-to-understand areas
- [ ] I have made corresponding changes to the documentation
- [ ] My changes generate no new warnings
- [ ] I have added tests that prove my fix is effective or that my feature works
- [ ] New and existing unit tests pass locally with my changes

**Breaking Changes**
If this is a breaking change, describe the migration path for existing users.

**Additional Notes**
Any additional information that would be helpful for reviewers.
```

## 🧪 Testing Contributions

### Running Tests

```bash
# Run all tests
make test

# Run specific test suites
go test ./internal/httpgen/...
go test ./internal/openapiv3/...
go test ./internal/tsclientgen/...
go test ./internal/tsservergen/...

# Run with coverage
make test-coverage

# Update golden files (when output intentionally changes)
UPDATE_GOLDEN=1 go test ./internal/httpgen/
UPDATE_GOLDEN=1 go test ./internal/openapiv3/
UPDATE_GOLDEN=1 go test ./internal/tsclientgen/
UPDATE_GOLDEN=1 go test ./internal/tsservergen/
```

### Adding New Tests

**Golden File Tests:**
```bash
# Add new test proto file
echo 'syntax = "proto3"; ...' > internal/httpgen/testdata/proto/new_test.proto

# Add expected output
echo '// Expected generated code' > internal/httpgen/testdata/golden/new_test_http.pb.go

# Update test to include new file
# Edit internal/httpgen/exhaustive_golden_test.go
```

**Unit Tests:**
```go
// Add to existing test file or create new one
func TestNewFeature(t *testing.T) {
    // Test implementation
}
```

## 📖 Documentation Contributions

### Types of Documentation

**Code Documentation:**
- Function and type comments
- Package-level documentation
- Code examples in comments

**User Documentation:**
- README improvements
- Tutorial enhancements
- API reference updates
- Troubleshooting guides

**Examples:**
- Complete working examples
- Integration guides
- Best practice demonstrations

### Documentation Style Guide

**Structure:**
- Start with a clear problem statement
- Provide step-by-step solutions
- Include complete, working examples
- Add troubleshooting sections

**Writing Style:**
- Use active voice
- Be concise but thorough
- Include code examples
- Use consistent terminology

**Formatting:**
```markdown
# Main Heading (H1)

## Section Heading (H2)

### Subsection (H3)

**Bold for emphasis**
`code snippets`

```bash
# Commands
make generate
```

```go
// Go code examples
func Example() {
    // Code here
}
```
```

## 🎯 Contribution Targets

### High-Impact Areas

**1. Generator Improvements**
- Better error messages
- Performance optimizations
- Additional type support
- Enhanced customization options

**2. Framework Integrations**
- Gin middleware improvements
- Echo integration
- Chi router support
- FastHTTP compatibility

**3. Documentation & Examples**
- Real-world use cases
- Performance guides
- Migration documentation
- Video tutorials

**4. Developer Experience**
- Better tooling
- IDE integration
- Debugging helpers
- Configuration validation

### Current Priorities

Check our [GitHub Issues](https://github.com/SebastienMelki/sebuf/issues) with these labels:
- `good first issue` - Perfect for new contributors
- `help wanted` - Community contributions welcome
- `priority: high` - Important improvements needed
- `type: documentation` - Documentation improvements

## 🏆 Recognition

We believe in recognizing our contributors:

- **Contributors List** - All contributors are listed in our README
- **Release Notes** - Significant contributions highlighted in releases
- **Community Spotlight** - Featured contributions in discussions
- **Maintainer Opportunities** - Active contributors invited to help maintain

## 📞 Getting Help

### Where to Ask Questions

- **GitHub Discussions** - General questions and community chat
- **GitHub Issues** - Bug reports and feature requests
- **Discord** (coming soon) - Real-time community support

### Response Times

- **Bug reports**: Within 48 hours
- **Feature requests**: Within 1 week
- **Pull requests**: Within 72 hours for initial review
- **Questions**: Within 24 hours

## 🤝 Code of Conduct

### Our Pledge

We pledge to make participation in our project a harassment-free experience for everyone, regardless of age, body size, disability, ethnicity, gender identity and expression, level of experience, nationality, personal appearance, race, religion, or sexual identity and orientation.

### Our Standards

**Positive behaviors:**
- Using welcoming and inclusive language
- Being respectful of differing viewpoints and experiences
- Gracefully accepting constructive criticism
- Focusing on what is best for the community
- Showing empathy towards other community members

**Unacceptable behaviors:**
- Harassment, discrimination, or hate speech
- Trolling, insulting/derogatory comments, and personal attacks
- Public or private harassment
- Publishing others' private information without permission
- Other conduct which could reasonably be considered inappropriate

### Enforcement

Project maintainers are responsible for clarifying standards of acceptable behavior and are expected to take appropriate and fair corrective action in response to any instances of unacceptable behavior.

Report any unacceptable behavior to: [conduct@sebuf.dev](mailto:conduct@sebuf.dev)

## 🎉 Thank You!

Every contribution, no matter how small, helps make sebuf better for everyone. Whether you're:

- 🐛 Reporting your first bug
- 📝 Fixing a typo in documentation  
- ✨ Adding a major new feature
- 🧪 Writing tests
- 💬 Helping others in discussions

**You're making a difference!** 

The sebuf community thrives because of contributors like you. We're excited to see what you'll build with us.

---

**Happy Contributing!** 🚀

*For any questions about contributing, feel free to reach out in [GitHub Discussions](https://github.com/SebastienMelki/sebuf/discussions) or create an issue.*