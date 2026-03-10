<div align="center">
  <img src="docs/sebuf-logo.png" alt="sebuf logo" width="200">
  
  
  > **Build HTTP APIs from protobuf definitions**
  
  Transform your protobuf services into production-ready HTTP APIs with automatic documentation and validation.
</div>

<div align="center">

[![Go Version](https://img.shields.io/github/go-mod/go-version/SebastienMelki/sebuf)](https://golang.org/)
[![Build Status](https://img.shields.io/github/actions/workflow/status/SebastienMelki/sebuf/ci.yml?branch=main)](https://github.com/SebastienMelki/sebuf/actions)
[![Test Coverage](https://img.shields.io/badge/coverage-85%25-green)](./coverage/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

</div>

## 🚀 Try it in 30 seconds

```bash
# Clone and run the working example
git clone https://github.com/SebastienMelki/sebuf.git
cd sebuf/examples/simple-api
make demo
```

This starts a working HTTP API with JSON endpoints and OpenAPI docs - all generated from a simple `.proto` file.

## What you get

- **HTTP handlers** from protobuf services (JSON + binary support)
- **Type-safe Go HTTP clients** with functional options pattern and per-call customization
- **TypeScript HTTP clients** with full type safety, header helpers, and error handling
- **TypeScript HTTP servers** using the Web Fetch API, framework-agnostic (Node, Deno, Bun, Cloudflare Workers)
- **Mock server generation** with realistic field examples for rapid prototyping
- **Automatic request validation** using protovalidate with buf.validate annotations
- **HTTP header validation** with type checking and format validation (UUID, email, datetime)
- **Structured error responses** with field-level validation details in JSON or protobuf
- **Automatic Go error interface** for any message ending with "Error", enabling `errors.As()` and `errors.Is()`
- **OpenAPI v3.1 docs** that stay in sync with your code, one file per service for better organization
- **Zero runtime dependencies** - works with any Go HTTP framework

## How it works

From this protobuf definition:
```protobuf
service UserService {
  // Header validation at service level
  option (sebuf.http.service_headers) = {
    required_headers: [{
      name: "X-API-Key"
      type: "string"
      format: "uuid"
      required: true
    }]
  };
  
  rpc CreateUser(CreateUserRequest) returns (User);
}

message CreateUserRequest {
  // Automatic validation with buf.validate
  string name = 1 [
    (buf.validate.field).string = {
      min_len: 2, max_len: 100
    },
    (sebuf.http.field_examples) = {
      values: ["Alice Johnson", "Bob Smith", "Charlie Davis"]
    }
  ];
  string email = 2 [
    (buf.validate.field).string.email = true,
    (sebuf.http.field_examples) = {
      values: ["alice@example.com", "bob@example.com"]
    }
  ];
  
  oneof auth_method {
    EmailAuth email = 3;
    TokenAuth token = 4;
  }
}
```

sebuf generates:
```go
// HTTP handlers with automatic validation (both headers and body)
api.RegisterUserServiceServer(userService, api.WithMux(mux))

// Type-safe Go HTTP client with functional options
client := api.NewUserServiceClient("http://localhost:8080",
    api.WithUserServiceAPIKey("your-api-key"),
)
user, err := client.CreateUser(ctx, req)

// Mock server with realistic data (optional)
mockService := api.NewMockUserServiceServer()
api.RegisterUserServiceServer(mockService, api.WithMux(mux))

// Validation happens automatically:
// - Headers validated first (returns HTTP 400 for missing/invalid headers)
// - Then request body validated (returns HTTP 400 for invalid requests)
// OpenAPI docs (UserService.openapi.yaml) - includes validation rules, headers, and examples
```

```typescript
// TypeScript HTTP client with full type safety
const client = new UserServiceClient("http://localhost:8080", {
  apiKey: "your-api-key",
});
const user = await client.createUser({ name: "John", email: "john@example.com" });

// TypeScript HTTP server (framework-agnostic, Web Fetch API)
const routes = createUserServiceRoutes(handler);
// Wire into any framework: Bun.serve, Deno.serve, Express, Hono, etc.
```

## Quick setup

```bash
# Install the tools
go install github.com/SebastienMelki/sebuf/cmd/protoc-gen-go-http@latest
go install github.com/SebastienMelki/sebuf/cmd/protoc-gen-go-client@latest
go install github.com/SebastienMelki/sebuf/cmd/protoc-gen-openapiv3@latest
go install github.com/SebastienMelki/sebuf/cmd/protoc-gen-ts-client@latest
go install github.com/SebastienMelki/sebuf/cmd/protoc-gen-ts-server@latest

# Try the complete example
cd examples/simple-api && make demo
```

## Next steps

- **[Complete Tutorial](./examples/simple-api/)** - Full walkthrough with working code
- **[Documentation](./docs/)** - Comprehensive guides and API reference  
- **[More Examples](./docs/examples/)** - Additional patterns and use cases

## What's this good for?

- **Web & mobile APIs** - JSON/HTTP endpoints from protobuf definitions
- **API documentation** - OpenAPI specs that never get out of sync
- **Type-safe development** - Leverage protobuf's type system for HTTP APIs
- **Client generation** - Generate Go and TypeScript clients directly from your protobuf definitions
- **Server generation** - Generate TypeScript HTTP servers using the Web Fetch API

## Built on Great Tools

sebuf stands on the shoulders of giants, integrating with an incredible ecosystem:

- **[Protocol Buffers](https://protobuf.dev/)** by Google - The foundation for everything
- **[protovalidate](https://github.com/bufbuild/protovalidate)** by Buf - Powers our automatic validation  
- **[Buf CLI](https://buf.build/)** - Modern protobuf tooling and dependency management
- **[OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0)** - Industry standard API documentation
- **[Common Expression Language (CEL)](https://github.com/google/cel-go)** by Google - Flexible validation rules

We're grateful to all maintainers of these projects that make sebuf possible.

## Contributing

We welcome contributions! See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

## License

MIT License - see [LICENSE](./LICENSE)

## Star History

<a href="https://star-history.com/#SebastienMelki/sebuf&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=SebastienMelki/sebuf&type=Date&theme=dark" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=SebastienMelki/sebuf&type=Date" />
 </picture>
</a>
