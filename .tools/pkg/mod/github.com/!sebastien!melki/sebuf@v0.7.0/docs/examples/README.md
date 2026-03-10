# Examples

> **Learn sebuf through working examples**

## Quick Start: Simple API

**Want to see sebuf in action immediately?**

```bash
git clone https://github.com/SebastienMelki/sebuf.git
cd sebuf/examples/simple-api
make demo
```

This starts a working HTTP API with user management, authentication, and OpenAPI docs.

**[Go to Simple API Tutorial](../../examples/simple-api/)**

---

## All Examples

| Example | Description | Key Features |
|---------|-------------|--------------|
| **[simple-api](../../examples/simple-api/)** | User authentication API | Oneof helpers, multiple auth methods, basic HTTP endpoints |
| **[restful-crud](../../examples/restful-crud/)** | Product catalog API | GET, POST, PUT, PATCH, DELETE, path params, query params, pagination |
| **[validation-showcase](../../examples/validation-showcase/)** | Order processing API | buf.validate patterns: string, numeric, array, map, nested validation |
| **[nested-resources](../../examples/nested-resources/)** | Organization hierarchy API | Deep path nesting (3 levels), multiple path params per endpoint |
| **[multi-service-api](../../examples/multi-service-api/)** | Multi-tenant platform | Multiple services, different auth levels, service/method headers |
| **[market-data-unwrap](../../examples/market-data-unwrap/)** | Financial market data API | Unwrap annotation for map values, JSON/protobuf compatibility |
| **[ts-client-demo](../../examples/ts-client-demo/)** | TypeScript client demo | TypeScript HTTP client, CRUD API, query params, headers, error handling |
| **[ts-fullstack-demo](../../examples/ts-fullstack-demo/)** | TypeScript full-stack demo | TS client + TS server from same proto, CRUD, unwrap, custom errors |

---

## Example Details

### simple-api
Basic introduction to sebuf with user authentication.
- Oneof helpers for type-safe authentication methods
- JSON and binary protobuf support
- OpenAPI documentation generation

```bash
cd examples/simple-api && make demo
```

### restful-crud
Complete RESTful CRUD operations for a product catalog.
- All HTTP verbs: GET, POST, PUT, PATCH, DELETE
- Path parameters: `/products/{product_id}`
- Query parameters: pagination, filtering, sorting
- PUT vs PATCH semantics with optional fields
- **Generated HTTP client** with functional options pattern

```bash
cd examples/restful-crud && make demo
```

See `client_example.go` for HTTP client usage examples.

### validation-showcase
Comprehensive buf.validate validation patterns.
- String: min_len, max_len, email, uuid, pattern (regex), enum
- Numeric: gte, lte, gt, lt bounds
- Array: min_items, max_items, unique items
- Map: max_pairs, key/value validation
- Nested message validation

```bash
cd examples/validation-showcase && make demo
```

### nested-resources
Complex resource hierarchies with multiple path parameters.
- Organization > Team > Member/Project hierarchy
- Up to 3 path parameters per endpoint
- GitHub-style nested resource URLs

```bash
cd examples/nested-resources && make demo
```

**Endpoints:**
```
GET  /api/v1/orgs/{org_id}/teams/{team_id}/members/{member_id}
POST /api/v1/orgs/{org_id}/teams/{team_id}/projects
```

### multi-service-api
Multiple services with different authentication requirements.
- **PublicService** - No auth required (health, info)
- **UserService** - User auth (Authorization + X-Tenant-ID)
- **AdminService** - Admin auth with method-specific headers

```bash
cd examples/multi-service-api && make demo
```

**Header patterns:**
- Service-level headers applied to all methods
- Method-level headers for specific operations (X-Confirm-Delete, X-Audit-Reason)

### market-data-unwrap
Financial market data API demonstrating the `unwrap` annotation.
- `(sebuf.http.unwrap)` annotation for cleaner JSON serialization
- Map values serialized as arrays instead of wrapped objects
- Real-world pattern from APIs like Alpaca Market Data

```bash
cd examples/market-data-unwrap && make run    # Start server
cd examples/market-data-unwrap && make client # Run client example
```

**JSON output with unwrap:**
```json
{"bars": {"TSLA": [{"c": 143.08, ...}]}}
```

**Without unwrap (standard protobuf):**
```json
{"bars": {"TSLA": {"bars": [{"c": 143.08, ...}]}}}
```

See [JSON/Protobuf Compatibility Guide](../json-protobuf-compatibility.md) for details.

### ts-client-demo
End-to-end TypeScript HTTP client demo with a NoteService CRUD API.
- Generated TypeScript client from `protoc-gen-ts-client`
- Full CRUD: create, list, get, update, delete notes
- Query parameters: filter by status, limit results
- Service-level headers (X-API-Key) and method-level headers (X-Request-ID)
- Structured error handling: `ValidationError` and `ApiError`
- Go server implementing `NoteServiceServer` with in-memory store

```bash
cd examples/ts-client-demo && make demo
```

**Prerequisites**: Node.js (for the TypeScript client)

### ts-fullstack-demo
Full TypeScript stack: both client and server generated from the same proto.
- Generated TypeScript server from `protoc-gen-ts-server` (Web Fetch API)
- Generated TypeScript client from `protoc-gen-ts-client`
- Full CRUD: create, list, get, update, archive, delete notes
- Query parameters, pagination, unwrap (getNotesByTag returns Note[])
- Service-level headers (X-API-Key, X-Tenant-ID) and method-level headers
- Proto-defined custom errors: `NotFoundError` (404) and `LoginError` (401) as proto messages, generating TypeScript interfaces used by both server and client for type-safe error handling
- Header validation (missing required headers return ValidationError)
- Interactive browser UI at http://localhost:3000 with live server log streaming
- Comprehensive colored request/response logging in the terminal (both server and client)

```bash
# Two-terminal setup (recommended — see both server and client logs):
cd examples/ts-fullstack-demo && make server   # Terminal 1
cd examples/ts-fullstack-demo && make client   # Terminal 2

# Or single command (server logs interleaved with client):
cd examples/ts-fullstack-demo && make demo
```

**Prerequisites**: Node.js 18+ (for Web Fetch API support)

---

## Running Examples

Each example follows the same pattern:

```bash
# Run complete demo (generate + run)
make demo

# Individual steps
make generate  # Generate code from proto
make run       # Start the server
make test      # Test with curl commands
make clean     # Remove generated files
```

## What Each Example Demonstrates

| Feature | simple-api | restful-crud | validation | nested | multi-service | market-data | ts-client-demo | ts-fullstack-demo |
|---------|:----------:|:------------:|:----------:|:------:|:-------------:|:-----------:|:--------------:|:-----------------:|
| HTTP verbs (GET/POST) | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| PUT/PATCH/DELETE | - | Yes | - | Yes | Yes | - | Yes | Yes |
| Path parameters | - | Yes | - | Yes | Yes | - | Yes | Yes |
| Query parameters | - | Yes | - | Yes | - | Yes | Yes | Yes |
| buf.validate | Basic | Basic | Comprehensive | Basic | Basic | Yes | - | - |
| Header validation | - | Yes | - | - | Yes | Yes | Yes | Yes |
| Multiple services | - | - | - | - | Yes | - | - | - |
| Nested resources | - | - | - | Yes | - | - | - | - |
| Oneof helpers | Yes | - | - | - | - | - | - | - |
| **Go HTTP Client** | - | **Yes** | - | - | - | **Yes** | - | - |
| **TS HTTP Client** | - | - | - | - | - | - | **Yes** | **Yes** |
| **TS HTTP Server** | - | - | - | - | - | - | - | **Yes** |
| **Unwrap annotation** | - | - | - | - | - | **Yes** | - | **Yes** |
| **Custom errors** | - | - | - | - | - | - | - | **Yes** |

---

## Want to contribute an example?

We welcome real-world examples that show sebuf solving actual problems. See [Contributing Guidelines](../../CONTRIBUTING.md).

---

**Start with the [Simple API Tutorial](../../examples/simple-api/)**
