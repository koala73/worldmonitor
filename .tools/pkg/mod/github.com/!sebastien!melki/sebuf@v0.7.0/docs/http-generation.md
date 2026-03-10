# HTTP Generation

> Transform protobuf services into production-ready HTTP APIs

The `protoc-gen-go-http` plugin generates complete HTTP server infrastructure from protobuf service definitions, enabling you to build JSON/HTTP APIs with the type safety and code generation benefits of protobuf.

## Table of Contents

- [Overview](#overview)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [HTTP Annotations](#http-annotations)
- [Field Examples](#field-examples)
- [Mock Server Generation](#mock-server-generation)
- [Header Validation](#header-validation)
- [Generated Code Structure](#generated-code-structure)
- [Framework Integration](#framework-integration)
- [Request/Response Handling](#requestresponse-handling)
- [Configuration Options](#configuration-options)
- [Advanced Examples](#advanced-examples)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)

## Overview

The HTTP generation plugin creates three main components from your protobuf service definitions:

1. **Service Interface** - Type-safe server interface matching your protobuf service
2. **HTTP Handlers** - Complete HTTP request/response handling with JSON and binary protobuf support
3. **Registration Functions** - Easy integration with Go HTTP frameworks and standard library

### Key Features

- **Multiple Content Types** - Automatic JSON and binary protobuf support
- **Framework Agnostic** - Works with any Go HTTP framework or standard library
- **Type Safe** - Full protobuf type checking and validation
- **Structured Error Responses** - Consistent protobuf-based error handling for all error types
- **Customizable Routing** - Control HTTP paths through annotations
- **Mock Server Generation** - Generate mock implementations with realistic data based on field examples
- **Header Validation** - Automatic validation of HTTP headers with type and format checking
- **Middleware Ready** - Built-in hooks for authentication, logging, etc.

## Installation

```bash
go install github.com/SebastienMelki/sebuf/cmd/protoc-gen-go-http@latest
```

Verify installation:
```bash
protoc-gen-go-http --version
```

## Quick Start

### 1. Define Your Service

Create `user_service.proto`:
```protobuf
syntax = "proto3";
package userapi;

import "sebuf/http/annotations.proto";

option go_package = "github.com/yourorg/userapi;userapi";

// User management service
service UserService {
  // Configure base path for all endpoints
  option (sebuf.http.service_config) = {
    base_path: "/api/v1"
  };
  
  // Create a new user
  rpc CreateUser(CreateUserRequest) returns (User) {
    option (sebuf.http.config) = {
      path: "/users"
      method: HTTP_METHOD_POST
    };
  }

  // Get user by ID
  rpc GetUser(GetUserRequest) returns (User) {
    option (sebuf.http.config) = {
      path: "/users/{id}"
      method: HTTP_METHOD_GET
    };
  }

  // List all users
  rpc ListUsers(ListUsersRequest) returns (ListUsersResponse) {
    option (sebuf.http.config) = {
      path: "/users"
      method: HTTP_METHOD_GET
    };
  }
}

message CreateUserRequest {
  string name = 1;
  string email = 2;
  string department = 3;
}

message GetUserRequest {
  string id = 1;
}

message ListUsersRequest {
  int32 page_size = 1;
  string page_token = 2;
  string department_filter = 3;
}

message User {
  string id = 1;
  string name = 2;
  string email = 3;
  string department = 4;
  int64 created_at = 5;
}

message ListUsersResponse {
  repeated User users = 1;
  string next_page_token = 2;
  int32 total_count = 3;
}
```

### 2. Generate HTTP Code

#### Using Buf (Recommended)

Create `buf.yaml`:
```yaml
version: v2
deps:
  - buf.build/sebmelki/sebuf  # For HTTP annotations
```

Create `buf.gen.yaml`:
```yaml
version: v2
plugins:
  - remote: buf.build/protocolbuffers/go
    out: .
    opt: module=github.com/yourorg/userapi
  - local: protoc-gen-go-http
    out: .
```

Generate:
```bash
buf generate
```

#### Generating with Mock Server

To also generate a mock server implementation, add the `generate_mock=true` option:

```yaml
# buf.gen.yaml
version: v2
plugins:
  - remote: buf.build/protocolbuffers/go
    out: .
    opt: module=github.com/yourorg/userapi
  - local: protoc-gen-go-http
    out: .
    opt: generate_mock=true
```

#### Using protoc

```bash
# Clone sebuf for annotations
git clone https://github.com/SebastienMelki/sebuf.git

# Generate with proper paths
protoc --go_out=. --go_opt=module=github.com/yourorg/userapi \
       --go-http_out=. \
       --proto_path=. \
       --proto_path=./sebuf/proto \
       user_service.proto
```

### 3. Implement Your Service

```go
package main

import (
    "context"
    "fmt"
    "log"
    "net/http"
    
    "github.com/yourorg/userapi"
)

// Implement the generated service interface
type UserServiceImpl struct {
    users map[string]*userapi.User
}

func (s *UserServiceImpl) CreateUser(ctx context.Context, req *userapi.CreateUserRequest) (*userapi.User, error) {
    user := &userapi.User{
        Id:         generateID(),
        Name:       req.Name,
        Email:      req.Email,
        Department: req.Department,
        CreatedAt:  time.Now().Unix(),
    }
    
    s.users[user.Id] = user
    return user, nil
}

func (s *UserServiceImpl) GetUser(ctx context.Context, req *userapi.GetUserRequest) (*userapi.User, error) {
    user, exists := s.users[req.Id]
    if !exists {
        return nil, fmt.Errorf("user not found: %s", req.Id)
    }
    return user, nil
}

func (s *UserServiceImpl) ListUsers(ctx context.Context, req *userapi.ListUsersRequest) (*userapi.ListUsersResponse, error) {
    var filteredUsers []*userapi.User
    
    for _, user := range s.users {
        if req.DepartmentFilter == "" || user.Department == req.DepartmentFilter {
            filteredUsers = append(filteredUsers, user)
        }
    }
    
    return &userapi.ListUsersResponse{
        Users:      filteredUsers,
        TotalCount: int32(len(filteredUsers)),
    }, nil
}

func main() {
    // Create service implementation
    userService := &UserServiceImpl{
        users: make(map[string]*userapi.User),
    }
    
    // Register HTTP handlers
    mux := http.NewServeMux()
    err := userapi.RegisterUserServiceServer(userService, userapi.WithMux(mux))
    if err != nil {
        log.Fatal(err)
    }
    
    // Start server
    fmt.Println("Server starting on :8080")
    fmt.Println("Endpoints:")
    fmt.Println("  POST   /api/v1/users       - Create user")
    fmt.Println("  GET    /api/v1/users/{id}  - Get user")
    fmt.Println("  GET    /api/v1/users       - List users")

    log.Fatal(http.ListenAndServe(":8080", mux))
}
```

### 4. Test Your API

```bash
# Create a user (JSON)
curl -X POST http://localhost:8080/api/v1/users \
  -H "Content-Type: application/json" \
  -d '{
    "name": "John Doe",
    "email": "john@example.com", 
    "department": "Engineering"
  }'

# Get a user
curl -X GET http://localhost:8080/api/v1/users/123

# List users with filter
curl -X GET "http://localhost:8080/api/v1/users?page_size=10&department_filter=Engineering"
```

## HTTP Annotations

Control HTTP routing and behavior using protobuf options:

### Service-Level Configuration

```protobuf
service MyService {
  option (sebuf.http.service_config) = {
    base_path: "/api/v1";
  };
  
  // ... methods
}
```

**Options:**
- `base_path`: URL prefix for all methods in this service

### Method-Level Configuration  

```protobuf
rpc CreateUser(CreateUserRequest) returns (User) {
  option (sebuf.http.config) = {
    path: "/users";
  };
}
```

**Options:**
- `path`: Custom HTTP path for this method

### Path Resolution

The final HTTP path is determined by:

1. **Custom path with base path**: `base_path + path`
   ```protobuf
   // Results in: POST /api/v1/users
   option (sebuf.http.service_config) = { base_path: "/api/v1" };
   option (sebuf.http.config) = { path: "/users" };
   ```

2. **Custom path only**: Uses `path` directly
   ```protobuf
   // Results in: POST /custom/endpoint  
   option (sebuf.http.config) = { path: "/custom/endpoint" };
   ```

3. **Base path only**: Generates path from method name
   ```protobuf
   // Results in: POST /api/v1/create_user
   option (sebuf.http.service_config) = { base_path: "/api/v1" };
   ```

4. **Default**: Uses package and method name
   ```protobuf
   // Results in: POST /userapi/create_user (no annotations)
   ```

## Field Examples

Add example values to protobuf fields using the `field_examples` annotation. These examples are used in OpenAPI documentation and mock server generation.

### Basic Field Examples

```protobuf
import "sebuf/http/annotations.proto";

message CreateUserRequest {
  string name = 1 [
    (buf.validate.field).string = {
      min_len: 2,
      max_len: 100
    },
    (sebuf.http.field_examples) = {
      values: ["Alice Johnson", "Bob Smith", "Charlie Davis", "Diana Wilson"]
    }
  ];
  
  string email = 2 [
    (buf.validate.field).string.email = true,
    (sebuf.http.field_examples) = {
      values: [
        "alice.johnson@example.com",
        "bob.smith@example.com", 
        "charlie.davis@example.com"
      ]
    }
  ];
  
  int32 age = 3 [(sebuf.http.field_examples) = {
    values: ["25", "34", "42", "28"]
  }];
}
```

### Examples for Different Types

**String fields:**
```protobuf
string user_id = 1 [(sebuf.http.field_examples) = {
  values: [
    "550e8400-e29b-41d4-a716-446655440000",
    "f47ac10b-58cc-4372-a567-0e02b2c3d479"
  ]
}];
```

**Numeric fields:**
```protobuf
int64 timestamp = 1 [(sebuf.http.field_examples) = {
  values: ["1704067200", "1704153600", "1704240000"]
}];

double price = 2 [(sebuf.http.field_examples) = {
  values: ["29.99", "15.50", "199.95"]
}];
```

**Boolean fields:**
```protobuf
bool is_active = 1 [(sebuf.http.field_examples) = {
  values: ["true", "false"]
}];
```

### Benefits of Field Examples

- **OpenAPI Documentation** - Examples appear in generated OpenAPI specifications
- **Mock Server Generation** - Used to generate realistic mock data
- **Developer Experience** - Provide clear examples of expected data formats
- **Testing** - Help generate test cases with realistic data

## Mock Server Generation

Generate complete mock server implementations with realistic data based on your field examples.

### Enabling Mock Generation

Add the `generate_mock=true` option when generating HTTP code:

#### Using Buf

```yaml
# buf.gen.yaml
version: v2
plugins:
  - remote: buf.build/protocolbuffers/go
    out: .
    opt: module=github.com/yourorg/userapi
  - local: protoc-gen-go-http
    out: .
    opt: generate_mock=true
```

#### Using protoc

```bash
protoc --go-http_out=. --go-http_opt=generate_mock=true user_service.proto
```

### Generated Mock Server

The plugin generates a complete mock server implementation in `*_http_mock.pb.go`:

```go
// Generated mock server
func NewMockUserServiceServer() UserServiceServer {
    return &mockUserServiceServer{}
}

type mockUserServiceServer struct{}

func (s *mockUserServiceServer) CreateUser(ctx context.Context, req *CreateUserRequest) (*User, error) {
    // Returns realistic data based on field examples
    return &User{
        Id:        randomFieldExample("User.id"),        // From field examples
        Name:      randomFieldExample("User.name"),      // From field examples  
        Email:     randomFieldExample("User.email"),     // From field examples
        CreatedAt: time.Now().Unix(),
    }, nil
}
```

### Using Mock Server in Development

```go
package main

import (
    "log"
    "net/http"
    
    "github.com/yourorg/userapi"
)

func main() {
    // Use mock server for development
    mockService := userapi.NewMockUserServiceServer()
    
    mux := http.NewServeMux()
    err := userapi.RegisterUserServiceServer(mockService, userapi.WithMux(mux))
    if err != nil {
        log.Fatal(err)
    }
    
    log.Println("Mock server starting on :8080")
    log.Fatal(http.ListenAndServe(":8080", mux))
}
```

### Mock Data Generation

The mock server uses field examples to generate realistic responses:

- **Random Selection** - Randomly selects from available field examples
- **Type Safety** - Respects protobuf field types and validation rules
- **Realistic Data** - Uses your defined examples for consistent, meaningful test data
- **Fallback Values** - Provides sensible defaults when no examples are defined

### Benefits of Mock Generation

- **Rapid Prototyping** - Get a working API immediately for frontend development
- **Testing** - Use for integration tests and demo environments
- **Documentation** - Show realistic API responses in documentation
- **Development Workflow** - Enable parallel frontend/backend development

## Header Validation

The HTTP generator provides comprehensive header validation through service and method-level annotations.

### Service-Level Headers

Define headers that apply to all methods in a service:

```protobuf
import "sebuf/http/headers.proto";

service UserService {
  option (sebuf.http.service_headers) = {
    required_headers: [
      {
        name: "X-API-Key"
        description: "API authentication key"
        type: "string"
        required: true
        format: "uuid"
        example: "123e4567-e89b-12d3-a456-426614174000"
      },
      {
        name: "X-Tenant-ID"
        description: "Tenant identifier"
        type: "integer"
        required: true
      }
    ]
  };
  
  // All methods in this service will require X-API-Key and X-Tenant-ID headers
  rpc CreateUser(CreateUserRequest) returns (User);
  rpc GetUser(GetUserRequest) returns (User);
}
```

### Method-Level Headers

Define headers for specific methods (these override service-level headers with the same name):

```protobuf
service UserService {
  rpc CreateUser(CreateUserRequest) returns (User) {
    option (sebuf.http.method_headers) = {
      required_headers: [
        {
          name: "X-Request-ID"
          description: "Unique request identifier for tracing"
          type: "string"
          format: "uuid"
          required: true
        },
        {
          name: "X-Idempotency-Key"
          description: "Idempotency key for safe retries"
          type: "string"
          required: false
        }
      ]
    };
  };
}
```

### Supported Header Types

| Type | Description | Example |
|------|-------------|---------|
| `string` | Text values | `"Bearer token123"` |
| `integer` | Whole numbers | `42` |
| `number` | Decimal numbers | `3.14` |
| `boolean` | True/false values | `true` |
| `array` | Comma-separated values | `"value1,value2,value3"` |

### Supported String Formats

| Format | Description | Validation Pattern |
|--------|-------------|-------------------|
| `uuid` | UUID v4 | `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `email` | Email address | Standard email validation |
| `date-time` | ISO 8601 datetime | `2006-01-02T15:04:05Z07:00` |
| `date` | ISO 8601 date | `2006-01-02` |
| `time` | ISO 8601 time | `15:04:05` |

### Header Validation Behavior

1. **Validation Order**: Headers are validated before request body
2. **Required Headers**: Missing required headers return HTTP 400
3. **Type Validation**: Invalid types return HTTP 400 with details
4. **Format Validation**: Invalid formats return HTTP 400 with pattern info
5. **Header Merging**: Method headers override service headers with same name

### Generated Validation Code

The plugin generates header validation that returns structured errors:

```go
// Generated validation returns ValidationError with field-level violations
func validateHeaders(r *http.Request, serviceHeaders, methodHeaders []*Header) *ValidationError {
    var violations []*FieldViolation
    allHeaders := mergeHeaders(serviceHeaders, methodHeaders)
    
    for _, header := range allHeaders {
        value := r.Header.Get(header.Name)
        
        // Check required headers
        if header.Required && value == "" {
            violations = append(violations, &FieldViolation{
                Field: header.Name,
                Description: fmt.Sprintf("required header '%s' is missing", header.Name),
            })
            continue
        }
        
        // Validate type and format
        if err := validateHeaderValue(header, value); err != nil {
            violations = append(violations, &FieldViolation{
                Field: header.Name,
                Description: fmt.Sprintf("header '%s' validation failed: %v", header.Name, err),
            })
        }
    }
    
    if len(violations) > 0 {
        return &ValidationError{Violations: violations}
    }
    return nil
}
```

### Example: API with Authentication Headers

```protobuf
service AuthenticatedAPI {
  option (sebuf.http.service_config) = {
    base_path: "/api/v1"
  };
  
  option (sebuf.http.service_headers) = {
    required_headers: [
      {
        name: "Authorization"
        description: "Bearer token for authentication"
        type: "string"
        required: true
        example: "Bearer eyJhbGciOiJIUzI1NiIs..."
      },
      {
        name: "X-API-Version"
        description: "API version"
        type: "string"
        required: false
        example: "v1"
      }
    ]
  };
  
  rpc GetUserProfile(GetUserRequest) returns (UserProfile);
  
  rpc UpdateUserProfile(UpdateUserRequest) returns (UserProfile) {
    option (sebuf.http.method_headers) = {
      required_headers: [
        {
          name: "X-Request-ID"
          type: "string"
          format: "uuid"
          required: true
        }
      ]
    };
  };
}
```

### Testing with Headers

```bash
# Valid request with all required headers
curl -X POST http://localhost:8080/api/v1/users \
  -H "Content-Type: application/json" \
  -H "X-API-Key: 123e4567-e89b-12d3-a456-426614174000" \
  -H "X-Tenant-ID: 42" \
  -d '{"name": "John", "email": "john@example.com"}'

# Missing required header (returns 400)
curl -X POST http://localhost:8080/api/v1/users \
  -H "Content-Type: application/json" \
  -d '{"name": "John", "email": "john@example.com"}'
# Response: 400 Bad Request
# Body:
{
  "violations": [{
    "field": "X-API-Key",
    "description": "required header 'X-API-Key' is missing"
  }]
}

# Invalid header format (returns 400)
curl -X POST http://localhost:8080/api/v1/users \
  -H "Content-Type: application/json" \
  -H "X-API-Key: not-a-uuid" \
  -H "X-Tenant-ID: 42" \
  -d '{"name": "John", "email": "john@example.com"}'
# Response: 400 Bad Request
# Body:
{
  "violations": [{
    "field": "X-API-Key",
    "description": "header 'X-API-Key' validation failed: invalid UUID format"
  }]
}
```

## Generated Code Structure

The plugin generates three files for each protobuf file containing services:

### 1. Main HTTP File (`*_http.pb.go`)

**Service Interface:**
```go
// UserServiceServer is the server API for UserService service.
type UserServiceServer interface {
    CreateUser(context.Context, *CreateUserRequest) (*User, error)
    GetUser(context.Context, *GetUserRequest) (*User, error)
    ListUsers(context.Context, *ListUsersRequest) (*ListUsersResponse, error)
}
```

**Registration Function:**
```go
// RegisterUserServiceServer registers HTTP handlers for UserService
func RegisterUserServiceServer(server UserServiceServer, opts ...ServerOption) error
```

### 2. Binding File (`*_http_binding.pb.go`)

Contains middleware and request/response handling:

- **Content Type Support** - JSON and binary protobuf
- **Request Binding** - Automatic deserialization from HTTP requests  
- **Response Marshaling** - Automatic serialization to HTTP responses
- **Header Validation** - Automatic header validation middleware
- **Body Validation** - Automatic request body validation via buf.validate
- **Structured Error Handling** - Consistent protobuf-based error responses for validation and handler errors

### 3. Config File (`*_http_config.pb.go`)

Provides configuration options:

```go
// ServerOption configures HTTP server behavior
type ServerOption func(c *serverConfiguration)

// WithMux configures a custom HTTP ServeMux
func WithMux(mux *http.ServeMux) ServerOption
```

## Framework Integration

The generated code works with any Go HTTP framework:

### Standard Library

```go
mux := http.NewServeMux()
userapi.RegisterUserServiceServer(userService, userapi.WithMux(mux))
http.ListenAndServe(":8080", mux)
```

### Gin Framework

```go
import "github.com/gin-gonic/gin"

r := gin.Default()

// Convert gin router to http.ServeMux for sebuf
mux := http.NewServeMux()
userapi.RegisterUserServiceServer(userService, userapi.WithMux(mux))

// Mount sebuf handlers on gin
r.Any("/api/*path", gin.WrapH(mux))

r.Run(":8080")
```

### Echo Framework

```go
import "github.com/labstack/echo/v4"

e := echo.New()

// Create dedicated mux for sebuf
mux := http.NewServeMux() 
userapi.RegisterUserServiceServer(userService, userapi.WithMux(mux))

// Mount on echo
e.Any("/api/*", echo.WrapHandler(mux))

e.Start(":8080")
```

### Chi Router

```go
import "github.com/go-chi/chi/v5"

r := chi.NewRouter()

// sebuf handlers
mux := http.NewServeMux()
userapi.RegisterUserServiceServer(userService, userapi.WithMux(mux))

// Mount on chi
r.Mount("/api/", http.StripPrefix("/api", mux))

http.ListenAndServe(":8080", r)
```

## Request/Response Handling

### Content Type Support

The generated handlers automatically support multiple content types:

**JSON (default):**
```bash
curl -X POST /api/v1/users \
  -H "Content-Type: application/json" \
  -d '{"name": "John", "email": "john@example.com"}'
```

**Binary Protobuf:**
```bash
# Using protobuf binary format
curl -X POST /api/v1/users \
  -H "Content-Type: application/x-protobuf" \
  --data-binary @user_request.pb
```

### Request Processing Flow

1. **Header Validation** - Validates required headers and their formats
2. **Content Type Detection** - Checks `Content-Type` header
3. **Request Binding** - Deserializes based on content type
4. **Body Validation** - Protobuf validation (required fields, types) and buf.validate rules
5. **Service Call** - Invokes your service implementation
6. **Response Marshaling** - Serializes response in same format as request

### Error Handling

Generated handlers provide comprehensive structured error responses for both validation failures and service implementation errors.

#### Error Types

**1. Validation Errors** - Missing or invalid headers and request body validation:
```json
{
  "violations": [
    {
      "field": "X-API-Key", 
      "description": "required header 'X-API-Key' is missing"
    },
    {
      "field": "email",
      "description": "must be a valid email address"
    }
  ]
}
```

**2. Handler Errors** - Service implementation errors with structured messages:
```json
{
  "message": "user not found: 123"
}
```

#### Service Implementation Error Handling

```go
// Service implementation with error handling
func (s *UserService) GetUser(ctx context.Context, req *GetUserRequest) (*User, error) {
    if req.Id == "" {
        return nil, fmt.Errorf("user ID is required")
    }
    
    user, exists := s.users[req.Id]
    if !exists {
        return nil, fmt.Errorf("user not found: %s", req.Id)
    }
    
    return user, nil
}
```

#### Error Response Format

All errors are returned as protobuf messages serialized according to the request's `Content-Type`:

**JSON Format (application/json):**
```bash
curl -X POST /api/v1/users \
  -H "Content-Type: application/json" \
  -d '{"name": "", "email": "invalid"}'

# Response: HTTP 400 Bad Request
{
  "violations": [
    {
      "field": "name",
      "description": "field is required"
    },
    {
      "field": "email", 
      "description": "must be a valid email address"
    }
  ]
}
```

**Protobuf Format (application/x-protobuf):**
```bash
curl -X POST /api/v1/users/get \
  -H "Content-Type: application/x-protobuf" \
  --data-binary @invalid_request.pb

# Response: HTTP 500 Internal Server Error (binary protobuf Error message)
```

#### Error Hierarchy

1. **Header Validation** (HTTP 400) - Validated first, before request body processing
2. **Body Validation** (HTTP 400) - buf.validate rules for request messages
3. **Handler Errors** (HTTP 500) - Service implementation errors

#### Structured Error Messages

Both validation and handler errors use protobuf messages defined in `sebuf/http/errors.proto`:

```protobuf
// Validation errors with field-level detail
message ValidationError {
  repeated FieldViolation violations = 1;
}

message FieldViolation {
  string field = 1;         // Field name or header name
  string description = 2;   // Human-readable error description
}

// Handler errors with custom messages  
message Error {
  string message = 1;  // Error message from service implementation
}
```

#### Automatic Error Interface Implementation

The HTTP generator **automatically implements the Go `error` interface** for any protobuf message whose name ends with "Error". This means you can define custom error types in your protobuf files and they'll automatically work with Go's standard error handling patterns.

**Built-in Error Types:**
- `ValidationError` - For validation failures
- `Error` - For general service errors

**Custom Error Types:**
```protobuf
// Custom error types - automatically get error interface implementation
message UserNotFoundError {
  string user_id = 1;
  string message = 2;
}

message PermissionDeniedError {
  string resource = 1;
  string action = 2;
  string reason = 3;
}

message DatabaseError {
  string query = 1;
  string error_code = 2;
  string details = 3;
}
```

All of these will automatically implement `error` interface with:
- `Error() string` method that returns a formatted error message
- Support for `errors.As()` and `errors.Is()` patterns
- JSON serialization for HTTP responses

#### Client Error Handling

sebuf error types implement Go's standard `error` interface, enabling seamless error handling for client applications:

```go
import (
    "errors"
    sebufhttp "github.com/SebastienMelki/sebuf/http"
)

func handleAPIResponse(err error) {
    // Check for validation errors specifically
    var validationErr *sebufhttp.ValidationError
    if errors.As(err, &validationErr) {
        fmt.Printf("Validation failed: %s\n", validationErr.Error())
        // Output: "validation error: email: must be a valid email address"
        
        for _, violation := range validationErr.Violations {
            fmt.Printf("  - %s: %s\n", violation.Field, violation.Description)
        }
        return
    }
    
    // Check for service errors
    var sebufErr *sebufhttp.Error
    if errors.As(err, &sebufErr) {
        fmt.Printf("Service error: %s\n", sebufErr.Error())
        // Output: "user not found: 123"
        return
    }
}

// Works with standard error wrapping
func processData() error {
    if err := callAPI(); err != nil {
        var validationErr *sebufhttp.ValidationError
        if errors.As(err, &validationErr) {
            return fmt.Errorf("validation failed: %w", validationErr)
        }
        return fmt.Errorf("API call failed: %w", err)
    }
    return nil
}

// Custom error type handling
func handleUserOperation() error {
    resp, err := userService.GetUser(ctx, req)
    if err != nil {
        // Check for custom error types
        var userNotFoundErr *UserNotFoundError
        if errors.As(err, &userNotFoundErr) {
            fmt.Printf("User not found: %s\n", userNotFoundErr.Error())
            // Output: "usernotfounderror: user ID '123' not found"
            return fmt.Errorf("user operation failed: %w", userNotFoundErr)
        }
        
        var permissionErr *PermissionDeniedError  
        if errors.As(err, &permissionErr) {
            fmt.Printf("Permission denied: %s\n", permissionErr.Error())
            return fmt.Errorf("access denied: %w", permissionErr)
        }
        
        return fmt.Errorf("unexpected error: %w", err)
    }
    return nil
}
```

#### TypeScript Error Handling

The TypeScript generators (`protoc-gen-ts-client` and `protoc-gen-ts-server`) mirror Go's convention: any protobuf message whose name ends with "Error" generates a TypeScript interface. This enables type-safe custom error handling across the wire.

```protobuf
// Proto-defined errors — shared contract between server and client
message NotFoundError {
  string resource_type = 1;
  string resource_id = 2;
}

message LoginError {
  string reason = 1;
  string email = 2;
  int32 retry_after_seconds = 3;
}
```

**Server** — throw errors matching the proto shape, serialize in `onError`:
```typescript
import { type NotFoundError as NotFoundErrorType } from "./generated/proto/service_server.ts";

class NotFoundError extends Error implements NotFoundErrorType {
  resourceType: string;
  resourceId: string;
  constructor(type: string, id: string) {
    super(`${type} '${id}' not found`);
    this.resourceType = type;
    this.resourceId = id;
  }
}

// In onError hook:
if (err instanceof NotFoundError) {
  const body: NotFoundErrorType = { resourceType: err.resourceType, resourceId: err.resourceId };
  return new Response(JSON.stringify(body), { status: 404, headers: { "Content-Type": "application/json" } });
}
```

**Client** — parse `ApiError.body` with the same generated interface:
```typescript
import { ApiError, type NotFoundError, type LoginError } from "./generated/proto/service_client.ts";

try {
  await client.getUser({ id: "not-found" });
} catch (e) {
  if (e instanceof ApiError) {
    if (e.statusCode === 404) {
      const err = JSON.parse(e.body) as NotFoundError;
      console.log(err.resourceType, err.resourceId);
    } else if (e.statusCode === 401) {
      const err = JSON.parse(e.body) as LoginError;
      console.log(err.reason, err.retryAfterSeconds);
    }
  }
}
```

See the [ts-fullstack-demo](../examples/ts-fullstack-demo/) for a complete working example with both `NotFoundError` and `LoginError`.

## Configuration Options

### Server Options

```go
// Use custom ServeMux
mux := http.NewServeMux()
RegisterUserServiceServer(service, WithMux(mux))

// Use default ServeMux (http.DefaultServeMux)
RegisterUserServiceServer(service)
```

### Custom Middleware

Add middleware by wrapping the generated handlers:

```go
func loggingMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        log.Printf("%s %s", r.Method, r.URL.Path)
        next.ServeHTTP(w, r)
    })
}

// Apply middleware to the mux
mux := http.NewServeMux()
RegisterUserServiceServer(service, WithMux(mux))

// Wrap with middleware  
handler := loggingMiddleware(mux)
http.ListenAndServe(":8080", handler)
```

## Advanced Examples

### Authentication Service

```protobuf
service AuthService {
  option (sebuf.http.service_config) = {
    base_path: "/auth"
  };
  
  rpc Login(LoginRequest) returns (LoginResponse) {
    option (sebuf.http.config) = { path: "/login" };
  }
  
  rpc RefreshToken(RefreshRequest) returns (TokenResponse) {
    option (sebuf.http.config) = { path: "/refresh" };
  }
  
  rpc Logout(LogoutRequest) returns (LogoutResponse) {
    option (sebuf.http.config) = { path: "/logout" };
  }
}
```

### E-commerce API

```protobuf
service ProductService {
  option (sebuf.http.service_config) = {
    base_path: "/api/v1/products"
  };
  
  rpc CreateProduct(CreateProductRequest) returns (Product) {
    option (sebuf.http.config) = { path: "" };  // POST /api/v1/products
  }
  
  rpc GetProduct(GetProductRequest) returns (Product) {
    option (sebuf.http.config) = { path: "/get" };  // POST /api/v1/products/get
  }
  
  rpc SearchProducts(SearchRequest) returns (SearchResponse) {
    option (sebuf.http.config) = { path: "/search" };  // POST /api/v1/products/search
  }
}
```

### File Upload Service

```protobuf
service FileService {
  rpc UploadFile(UploadFileRequest) returns (UploadFileResponse) {
    option (sebuf.http.config) = { path: "/files/upload" };
  }
}

message UploadFileRequest {
  string filename = 1;
  bytes content = 2;
  string content_type = 3;
  map<string, string> metadata = 4;
}
```

### Map with Array Values (Unwrap)

When you need a map where values are arrays (common in market data APIs):

```protobuf
import "sebuf/http/annotations.proto";

// Wrapper message with unwrap annotation
message BarList {
  repeated Bar bars = 1 [(sebuf.http.unwrap) = true];
}

message GetBarsResponse {
  // JSON output: {"bars": {"AAPL": [...], "GOOG": [...]}}
  // Instead of: {"bars": {"AAPL": {"bars": [...]}, ...}}
  map<string, BarList> bars = 1;
}
```

See [JSON and Protobuf Compatibility](./json-protobuf-compatibility.md) for complete details.

## Best Practices

### 1. Consistent URL Design

```protobuf
// Good: RESTful paths with HTTP methods
service UserService {
  option (sebuf.http.service_config) = { base_path: "/api/v1" };

  rpc CreateUser(CreateUserRequest) returns (User) {
    option (sebuf.http.config) = {
      path: "/users"
      method: HTTP_METHOD_POST
    };
  }

  rpc GetUser(GetUserRequest) returns (User) {
    option (sebuf.http.config) = {
      path: "/users/{id}"
      method: HTTP_METHOD_GET
    };
  }

  rpc UpdateUser(UpdateUserRequest) returns (User) {
    option (sebuf.http.config) = {
      path: "/users/{id}"
      method: HTTP_METHOD_PUT
    };
  }

  rpc DeleteUser(DeleteUserRequest) returns (DeleteUserResponse) {
    option (sebuf.http.config) = {
      path: "/users/{id}"
      method: HTTP_METHOD_DELETE
    };
  }
}
```

### 2. Error Handling Strategy

```go
type UserService struct {
    repo UserRepository
}

func (s *UserService) GetUser(ctx context.Context, req *GetUserRequest) (*User, error) {
    // Validate input
    if req.Id == "" {
        return nil, status.Error(codes.InvalidArgument, "user ID is required")
    }
    
    // Business logic
    user, err := s.repo.FindByID(req.Id)
    if err != nil {
        if errors.Is(err, ErrUserNotFound) {
            return nil, status.Error(codes.NotFound, "user not found")
        }
        return nil, status.Error(codes.Internal, "failed to retrieve user")
    }
    
    return user, nil
}
```

### 3. Request Validation

```protobuf
message CreateUserRequest {
  string name = 1;           // Validate: non-empty, max length
  string email = 2;          // Validate: email format
  string department = 3;     // Validate: enum or predefined list
  repeated string roles = 4; // Validate: valid role names
}
```

```go
func (s *UserService) CreateUser(ctx context.Context, req *CreateUserRequest) (*User, error) {
    // Custom validation beyond protobuf
    if err := validateCreateUserRequest(req); err != nil {
        return nil, status.Error(codes.InvalidArgument, err.Error())
    }
    
    // Business logic...
}

func validateCreateUserRequest(req *CreateUserRequest) error {
    if req.Name == "" {
        return fmt.Errorf("name is required")
    }
    
    if len(req.Name) > 100 {
        return fmt.Errorf("name too long (max 100 characters)")
    }
    
    if !isValidEmail(req.Email) {
        return fmt.Errorf("invalid email format")
    }
    
    return nil
}
```

### 4. Testing Generated Handlers

```go
func TestUserServiceHTTP(t *testing.T) {
    // Create service implementation
    service := &UserServiceImpl{
        users: make(map[string]*User),
    }
    
    // Setup HTTP handlers
    mux := http.NewServeMux()
    err := RegisterUserServiceServer(service, WithMux(mux))
    require.NoError(t, err)
    
    // Test server
    server := httptest.NewServer(mux)
    defer server.Close()
    
    t.Run("CreateUser", func(t *testing.T) {
        reqBody := `{
            "name": "Test User",
            "email": "test@example.com",
            "department": "Engineering"
        }`
        
        resp, err := http.Post(
            server.URL+"/api/v1/users",
            "application/json",
            strings.NewReader(reqBody),
        )
        require.NoError(t, err)
        defer resp.Body.Close()
        
        assert.Equal(t, http.StatusOK, resp.StatusCode)
        
        var user User
        err = json.NewDecoder(resp.Body).Decode(&user)
        require.NoError(t, err)
        
        assert.Equal(t, "Test User", user.Name)
        assert.Equal(t, "test@example.com", user.Email)
    })
}
```

## Troubleshooting

### Common Issues

#### 1. Plugin Not Found
```
protoc-gen-go-http: program not found or is not executable
```

**Solution:**
```bash
# Ensure plugin is in PATH
export PATH=$PATH:$(go env GOPATH)/bin

# Reinstall plugin
go install github.com/SebastienMelki/sebuf/cmd/protoc-gen-go-http@latest
```

#### 2. Import Errors
```
cannot find package "github.com/SebastienMelki/sebuf/http"
```

**Solution:**
Ensure the annotations are available:
```bash
# Option 1: Use from Buf Schema Registry
echo 'deps: [buf.build/sebmelki/sebuf]' >> buf.yaml

# Option 2: Include in your module
go get github.com/SebastienMelki/sebuf/http
```

#### 3. No Handlers Generated
Check that:
- Your proto file contains `service` definitions
- Services have at least one `rpc` method
- You're using the correct plugin (`--go-http_out`)

#### 4. Path Conflicts
```
pattern /api/v1/users conflicts with pattern /api/
```

**Solution:**
Ensure path patterns don't overlap:
```protobuf
// Good: Specific paths
option (sebuf.http.config) = { path: "/users" };
option (sebuf.http.config) = { path: "/users/get" };

// Avoid: Overlapping patterns  
option (sebuf.http.config) = { path: "/users" };
option (sebuf.http.config) = { path: "/users/" };  // Conflicts
```

### Getting Help

- **Demo**: Try the [simple tutorial](../examples/)
- **Test Cases**: Review tests in `internal/httpgen/`
- **Issues**: File a GitHub issue with your proto definition
- **Discussions**: Join GitHub Discussions for questions

## Integration with Other sebuf Tools

### With OpenAPI Generation

Generate both HTTP handlers and OpenAPI documentation:

#### Using Buf

```yaml
# buf.gen.yaml
version: v2
plugins:
  - remote: buf.build/protocolbuffers/go
    out: .
    opt: module=github.com/yourorg/api
  - local: protoc-gen-go-http
    out: .
  - local: protoc-gen-openapiv3
    out: ./docs
```

```bash
buf generate
```

#### Using protoc

```bash
# Generate both HTTP handlers and OpenAPI spec
protoc --go_out=. --go_opt=module=github.com/yourorg/api \
       --go-http_out=. \
       --openapiv3_out=./docs \
       --proto_path=. \
       --proto_path=./sebuf/proto \
       api.proto
```

The OpenAPI spec will automatically reflect your HTTP annotations and routing.

---

**Next:** Learn how to generate comprehensive API documentation with [OpenAPI Generation](./openapi-generation.md)

**See also:**
- [Getting Started Guide](./getting-started.md)
- [Validation Guide](./validation.md)
- [JSON/Protobuf Compatibility](./json-protobuf-compatibility.md)
- [All Examples](./examples/)

**Feature-specific examples:**
- [restful-crud](../examples/restful-crud/) - All HTTP verbs, path params, query params
- [nested-resources](../examples/nested-resources/) - Deep path nesting with multiple path params
- [multi-service-api](../examples/multi-service-api/) - Service/method-level header validation