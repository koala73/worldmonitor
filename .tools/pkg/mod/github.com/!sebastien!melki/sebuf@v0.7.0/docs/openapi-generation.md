# OpenAPI Generation

> Generate comprehensive OpenAPI v3.1 specifications from protobuf definitions

The `protoc-gen-openapiv3` plugin automatically creates detailed OpenAPI specifications from your protobuf service definitions, ensuring your API documentation stays perfectly synchronized with your implementation.

## Table of Contents

- [Overview](#overview)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Generated Specification Structure](#generated-specification-structure)
- [Type Mapping](#type-mapping)
- [Advanced Examples](#advanced-examples)
- [Output Formats](#output-formats)
- [Integration with HTTP Generation](#integration-with-http-generation)
- [Customization Options](#customization-options)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)

## Overview

The OpenAPI generation plugin bridges the gap between protobuf service definitions and modern API documentation standards. It creates complete OpenAPI v3.1 specifications that include:

- **Complete Schema Definitions** - All protobuf messages converted to JSON schemas
- **Service Endpoints** - RPC methods mapped to HTTP operations
- **Header Parameters** - HTTP headers from service and method annotations included as parameters
- **Field Examples** - Example values from protobuf field annotations included in OpenAPI
- **Type Safety** - Accurate type information including enums, arrays, and nested objects
- **Documentation** - Comments from protobuf definitions preserved as descriptions
- **Validation Rules** - Both buf.validate constraints and header validation rules reflected in OpenAPI

### Key Benefits

- **Always Up-to-Date** - Documentation generated directly from source of truth
- **Multi-Format Output** - JSON and YAML formats supported
- **Client Generation** - Use with OpenAPI client generators for any language
- **API Testing** - Import into testing tools like Postman, Insomnia
- **Developer Experience** - Rich documentation for API consumers

## Installation

```bash
go install github.com/SebastienMelki/sebuf/cmd/protoc-gen-openapiv3@latest
```

Verify installation:
```bash
protoc-gen-openapiv3 --version
```

## Quick Start

### 1. Define Your Service

Create `user_api.proto`:
```protobuf
syntax = "proto3";
package userapi.v1;

option go_package = "github.com/yourorg/userapi/v1;userapi";

// User represents a system user
message User {
  // Unique user identifier
  string id = 1 [(sebuf.http.field_examples) = {
    values: [
      "550e8400-e29b-41d4-a716-446655440000",
      "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      "123e4567-e89b-12d3-a456-426614174000"
    ]
  }];
  
  // User's email address
  string email = 2 [(sebuf.http.field_examples) = {
    values: [
      "alice.johnson@example.com",
      "bob.smith@example.com",
      "charlie.davis@example.com"
    ]
  }];
  
  // Full name of the user
  string name = 3 [(sebuf.http.field_examples) = {
    values: ["Alice Johnson", "Bob Smith", "Charlie Davis", "Diana Wilson"]
  }];
  
  // Age in years
  int32 age = 4 [(sebuf.http.field_examples) = {
    values: ["25", "34", "42", "28"]
  }];
  
  // Tags associated with the user
  repeated string tags = 5 [(sebuf.http.field_examples) = {
    values: ["engineer", "manager", "designer"]
  }];
  
  // Additional metadata
  map<string, string> metadata = 6;
  
  // Current user status
  UserStatus status = 7;
  
  // User's profile settings
  UserProfile profile = 8;
}

// UserProfile contains user profile information
message UserProfile {
  // Profile picture URL
  string avatar_url = 1;
  
  // User's bio or description
  string bio = 2;
  
  // Preferred language code (ISO 639-1)
  string language = 3;
  
  // Timezone identifier
  string timezone = 4;
}

// UserStatus represents the user's current status
enum UserStatus {
  USER_STATUS_UNSPECIFIED = 0;
  USER_STATUS_ACTIVE = 1;
  USER_STATUS_INACTIVE = 2;
  USER_STATUS_SUSPENDED = 3;
}

// Request to create a new user
message CreateUserRequest {
  // The user to create
  User user = 1;
  
  // Whether to send welcome email
  bool send_welcome_email = 2;
}

// Response containing the created user
message CreateUserResponse {
  // The created user with generated ID
  User user = 1;
  
  // Timestamp when user was created
  int64 created_at = 2;
}

// Request to get a user by ID
message GetUserRequest {
  // User ID to retrieve
  string id = 1;
}

// Response containing the requested user
message GetUserResponse {
  // The requested user
  User user = 1;
}

// Request to list users with filtering
message ListUsersRequest {
  // Maximum number of users to return
  int32 page_size = 1;
  
  // Token for pagination
  string page_token = 2;
  
  // Filter by user status
  UserStatus status_filter = 3;
  
  // Search query for name or email
  string search_query = 4;
}

// Response containing list of users
message ListUsersResponse {
  // List of users
  repeated User users = 1;
  
  // Token for next page
  string next_page_token = 2;
  
  // Total number of users (for pagination info)
  int32 total_count = 3;
}

// UserService manages users in the system
service UserService {
  // CreateUser creates a new user in the system
  rpc CreateUser(CreateUserRequest) returns (CreateUserResponse);
  
  // GetUser retrieves an existing user by ID
  rpc GetUser(GetUserRequest) returns (GetUserResponse);
  
  // ListUsers returns a paginated list of users
  rpc ListUsers(ListUsersRequest) returns (ListUsersResponse);
}
```

### 2. Generate OpenAPI Specification

#### Using Buf (Recommended)

Create `buf.yaml`:
```yaml
version: v2
# Add sebuf dependency if using HTTP annotations
deps:
  - buf.build/sebmelki/sebuf  # Optional, only if using HTTP annotations
```

Create `buf.gen.yaml`:
```yaml
version: v2
plugins:
  - remote: buf.build/protocolbuffers/go
    out: .
    opt: paths=source_relative
  - local: protoc-gen-openapiv3
    out: ./docs
    # For JSON format instead of YAML:
    # opt: format=json
    # For custom filename:
    # opt: filename=my_api.yaml
```

Generate:
```bash
buf generate
```

#### Using protoc

```bash
# Generate YAML format (default)
protoc --openapiv3_out=./docs user_api.proto

# Generate JSON format
protoc --openapiv3_out=./docs --openapiv3_opt=format=json user_api.proto

# Custom output filename
protoc --openapiv3_out=./docs --openapiv3_opt=filename=user_api.yaml user_api.proto
```

### 3. View Generated Specification

The generated `user_api.yaml` will contain:

```yaml
openapi: 3.1.0
info:
  title: userapi.v1 API
  version: 1.0.0
  
paths:
  /userapi/create_user:
    post:
      summary: CreateUser creates a new user in the system
      operationId: CreateUser
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreateUserRequest'
      responses:
        '200':
          description: Successful response
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/CreateUserResponse'
                
  /userapi/get_user:
    post:
      summary: GetUser retrieves an existing user by ID
      operationId: GetUser
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/GetUserRequest'
      responses:
        '200':
          description: Successful response
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/GetUserResponse'

components:
  schemas:
    User:
      type: object
      description: User represents a system user
      properties:
        id:
          type: string
          description: Unique user identifier
          examples:
            - "550e8400-e29b-41d4-a716-446655440000"
            - "f47ac10b-58cc-4372-a567-0e02b2c3d479"
            - "123e4567-e89b-12d3-a456-426614174000"
        email:
          type: string
          description: User's email address
          examples:
            - "alice.johnson@example.com"
            - "bob.smith@example.com"
            - "charlie.davis@example.com"
        name:
          type: string
          description: Full name of the user
          examples:
            - "Alice Johnson"
            - "Bob Smith"
            - "Charlie Davis"
            - "Diana Wilson"
        age:
          type: integer
          format: int32
          description: Age in years
          examples:
            - 25
            - 34
            - 42
            - 28
        tags:
          type: array
          description: Tags associated with the user
          items:
            type: string
          examples:
            - ["engineer"]
            - ["manager"]
            - ["designer"]
        metadata:
          type: object
          description: Additional metadata
          additionalProperties:
            type: string
        status:
          $ref: '#/components/schemas/UserStatus'
        profile:
          $ref: '#/components/schemas/UserProfile'
    
    UserStatus:
      type: string
      description: UserStatus represents the user's current status
      enum:
        - USER_STATUS_UNSPECIFIED
        - USER_STATUS_ACTIVE
        - USER_STATUS_INACTIVE
        - USER_STATUS_SUSPENDED
    
    UserProfile:
      type: object
      description: UserProfile contains user profile information
      properties:
        avatarUrl:
          type: string
          description: Profile picture URL
        bio:
          type: string
          description: User's bio or description
        language:
          type: string
          description: Preferred language code (ISO 639-1)
        timezone:
          type: string
          description: Timezone identifier
```

### 4. Use the Specification

**Import into API tools:**
```bash
# Postman
curl -X POST https://api.getpostman.com/import \
  -H "X-Api-Key: YOUR_API_KEY" \
  -F "file=@docs/user_api.yaml"

# Swagger UI (local)
docker run -p 8080:8080 -v $(pwd)/docs:/app swaggerapi/swagger-ui
```

**Generate client code:**
```bash
# Generate TypeScript client
openapi-generator-cli generate \
  -i docs/user_api.yaml \
  -g typescript-fetch \
  -o clients/typescript

# Generate Python client  
openapi-generator-cli generate \
  -i docs/user_api.yaml \
  -g python \
  -o clients/python
```

## Generated Specification Structure

### Document Information

```yaml
openapi: 3.1.0
info:
  title: "{package_name} API"      # Derived from protobuf package
  version: "1.0.0"                 # Default version
  description: ""                  # Can be customized
```

### Header Parameters

When using header annotations, the OpenAPI specification automatically includes header parameters:

```yaml
paths:
  /endpoint:
    post:
      parameters:
        - name: X-API-Key
          in: header
          required: true
          description: API authentication key
          schema:
            type: string
            format: uuid
            example: "123e4567-e89b-12d3-a456-426614174000"
        - name: X-Tenant-ID
          in: header
          required: false
          description: Tenant identifier
          schema:
            type: integer
            minimum: 1
      requestBody:
        # ...
```

### Paths

Each protobuf service method becomes an OpenAPI path:

```yaml
paths:
  /{package}/{method_name}:        # Default path pattern
    post:                          # All methods use POST
      summary: "{method_comment}"   # From protobuf comments
      operationId: "{method_name}"  # RPC method name
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/{RequestType}'
      responses:
        '200':
          description: Successful response
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/{ResponseType}'
```

### Components/Schemas

All protobuf messages become reusable schemas:

```yaml
components:
  schemas:
    MessageName:
      type: object
      description: "{message_comment}"
      properties:
        field_name:
          type: string
          description: "{field_comment}"
```

## Type Mapping

The plugin provides comprehensive mapping between protobuf types and OpenAPI schemas:

### Scalar Types

| Protobuf Type | OpenAPI Type | Format | Notes |
|---------------|--------------|--------|-------|
| `string` | `string` | - | UTF-8 encoded |
| `bytes` | `string` | `byte` | Base64 encoded |
| `bool` | `boolean` | - | |
| `int32`, `sint32`, `sfixed32` | `integer` | `int32` | |
| `int64`, `sint64`, `sfixed64` | `integer` | `int64` | |
| `uint32`, `fixed32` | `integer` | `int32` | `minimum: 0` |
| `uint64`, `fixed64` | `integer` | `int64` | `minimum: 0` |
| `float` | `number` | `float` | |
| `double` | `number` | `double` | |

### Complex Types

**Repeated Fields (Arrays):**
```protobuf
repeated string tags = 1;
```
```yaml
tags:
  type: array
  items:
    type: string
```

**Map Fields (Objects):**
```protobuf
map<string, string> metadata = 1;
```
```yaml
metadata:
  type: object
  additionalProperties:
    type: string
```

**Map Fields with Unwrap (Array Values):**

When map values use the `unwrap` annotation, the OpenAPI schema reflects the unwrapped structure:

```protobuf
message BarList {
  repeated Bar bars = 1 [(sebuf.http.unwrap) = true];
}

message Response {
  map<string, BarList> bars = 1;
}
```
```yaml
bars:
  type: object
  additionalProperties:
    type: array
    items:
      $ref: '#/components/schemas/Bar'
```

**Root-Level Unwrap (Map or Array at Root):**

When a message has a single field with `unwrap`, the entire schema becomes that field's type:

```protobuf
// Root map unwrap - response is a plain object
message UsersResponse {
  map<string, User> users = 1 [(sebuf.http.unwrap) = true];
}
```
```yaml
UsersResponse:
  type: object
  additionalProperties:
    $ref: '#/components/schemas/User'
```

```protobuf
// Root repeated unwrap - response is a plain array
message UserList {
  repeated User users = 1 [(sebuf.http.unwrap) = true];
}
```
```yaml
UserList:
  type: array
  items:
    $ref: '#/components/schemas/User'
```

```protobuf
// Combined unwrap - root map + value unwrap
message BarsResponse {
  map<string, BarList> data = 1 [(sebuf.http.unwrap) = true];
}
```
```yaml
BarsResponse:
  type: object
  additionalProperties:
    type: array
    items:
      $ref: '#/components/schemas/Bar'
```

See [JSON/Protobuf Compatibility](./json-protobuf-compatibility.md) for details.

**Enums:**
```protobuf
enum Status {
  ACTIVE = 0;
  INACTIVE = 1;
}
```
```yaml
Status:
  type: string
  enum:
    - ACTIVE
    - INACTIVE
```

**Message References:**
```protobuf
UserProfile profile = 1;
```
```yaml
profile:
  $ref: '#/components/schemas/UserProfile'
```

**Field Examples:**
```protobuf
string email = 1 [(sebuf.http.field_examples) = {
  values: ["alice@example.com", "bob@example.com", "charlie@example.com"]
}];
```
```yaml
email:
  type: string
  examples:
    - "alice@example.com"
    - "bob@example.com"
    - "charlie@example.com"
```

**Optional Fields (Proto3):**
```protobuf
optional string middle_name = 1;
```
```yaml
middleName:
  type: string
  # Handled according to OpenAPI 3.1 nullable semantics
```

## Advanced Examples

### Nested Messages

```protobuf
message Company {
  string name = 1;
  Address headquarters = 2;
  repeated Department departments = 3;
}

message Address {
  string street = 1;
  string city = 2;
  string country = 3;
  optional string postal_code = 4;
}

message Department {
  string name = 1;
  repeated Employee employees = 2;
  Employee manager = 3;
}

message Employee {
  string id = 1;
  string name = 2;
  string email = 3;
  repeated string skills = 4;
  map<string, string> certifications = 5;
}
```

Generates comprehensive schemas with proper references:

```yaml
components:
  schemas:
    Company:
      type: object
      properties:
        name:
          type: string
        headquarters:
          $ref: '#/components/schemas/Address'
        departments:
          type: array
          items:
            $ref: '#/components/schemas/Department'
    
    Address:
      type: object
      properties:
        street:
          type: string
        city:
          type: string
        country:
          type: string
        postalCode:
          type: string
    
    Department:
      type: object
      properties:
        name:
          type: string
        employees:
          type: array
          items:
            $ref: '#/components/schemas/Employee'
        manager:
          $ref: '#/components/schemas/Employee'
```

### Complex Enums

```protobuf
// Priority levels for task management
enum Priority {
  PRIORITY_UNSPECIFIED = 0;  // Default priority
  PRIORITY_LOW = 1;          // Low priority tasks
  PRIORITY_MEDIUM = 2;       // Medium priority tasks  
  PRIORITY_HIGH = 3;         // High priority tasks
  PRIORITY_URGENT = 4;       // Urgent tasks requiring immediate attention
}
```

```yaml
Priority:
  type: string
  description: Priority levels for task management
  enum:
    - PRIORITY_UNSPECIFIED  # Default priority
    - PRIORITY_LOW          # Low priority tasks
    - PRIORITY_MEDIUM       # Medium priority tasks
    - PRIORITY_HIGH         # High priority tasks
    - PRIORITY_URGENT       # Urgent tasks requiring immediate attention
```

### API with Multiple Services

```protobuf
// Authentication service
service AuthService {
  rpc Login(LoginRequest) returns (LoginResponse);
  rpc Logout(LogoutRequest) returns (LogoutResponse);
  rpc RefreshToken(RefreshTokenRequest) returns (RefreshTokenResponse);
}

// User management service
service UserService {
  rpc CreateUser(CreateUserRequest) returns (CreateUserResponse);
  rpc UpdateUser(UpdateUserRequest) returns (UpdateUserResponse);
  rpc DeleteUser(DeleteUserRequest) returns (DeleteUserResponse);
}

// Notification service
service NotificationService {
  rpc SendEmail(SendEmailRequest) returns (SendEmailResponse);
  rpc SendPush(SendPushRequest) returns (SendPushResponse);
}
```

**Each service generates its own OpenAPI specification file:**

- `AuthService.openapi.yaml` - Contains authentication endpoints
- `UserService.openapi.yaml` - Contains user management endpoints  
- `NotificationService.openapi.yaml` - Contains notification endpoints

This per-service approach provides:
- **Better organization** - Each service has its own API documentation
- **Independent versioning** - Services can evolve separately
- **Easier deployment** - Deploy only the API specs you need
- **Team ownership** - Different teams can manage their service docs

Example `UserService.openapi.yaml`:
```yaml
openapi: 3.1.0
info:
  title: UserService API
  version: 1.0.0
paths:
  /user/create_user:
    post: { ... }
  /user/update_user:
    post: { ... }
  /user/delete_user:
    post: { ... }
```

## Output Formats

### YAML Format (Default)

```bash
protoc --openapiv3_out=./docs api.proto
# Generates: ServiceName.openapi.yaml for each service
# Example: UserService.openapi.yaml, AdminService.openapi.yaml
```

**Advantages:**
- Human-readable and editable
- Supports comments (preserved from protobuf)
- Standard for OpenAPI documentation
- Direct import into most tools

### JSON Format

```bash
protoc --openapiv3_out=./docs --openapiv3_opt=format=json api.proto
# Generates: ServiceName.openapi.json for each service
# Example: UserService.openapi.json, AdminService.openapi.json
```

**Advantages:**
- Programmatic processing
- Faster parsing
- Smaller file size
- Direct use in JavaScript applications

### File Naming Convention

The plugin automatically generates one file per service with the naming pattern:
- YAML: `{ServiceName}.openapi.yaml`
- JSON: `{ServiceName}.openapi.json`

This ensures:
- No file conflicts when multiple services exist
- Clear association between service and its documentation
- Easy to manage and deploy individual service specs

## Integration with HTTP Generation

When used together with `protoc-gen-go-http`, the OpenAPI specification will accurately reflect your actual HTTP endpoints:

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
# Clone sebuf for HTTP annotations
git clone https://github.com/SebastienMelki/sebuf.git

# Generate both HTTP handlers and OpenAPI spec
protoc --go_out=. --go_opt=module=github.com/yourorg/api \
       --go-http_out=. \
       --openapiv3_out=./docs \
       --proto_path=. \
       --proto_path=./sebuf/proto \
       api.proto
```

**Benefits of combined generation:**
- **Accurate paths** - OpenAPI paths match actual HTTP routes
- **Consistent behavior** - Same type handling in both systems
- **Single source of truth** - One protobuf definition drives everything
- **Testing alignment** - Test against the same spec that documents the API

### With HTTP Annotations and Headers

```protobuf
import "sebuf/http/annotations.proto";
import "sebuf/http/headers.proto";

service UserService {
  option (sebuf.http.service_config) = {
    base_path: "/api/v1"
  };
  
  option (sebuf.http.service_headers) = {
    required_headers: [
      {
        name: "X-API-Key"
        description: "API authentication key"
        type: "string"
        format: "uuid"
        required: true
        example: "123e4567-e89b-12d3-a456-426614174000"
      }
    ]
  };
  
  rpc CreateUser(CreateUserRequest) returns (User) {
    option (sebuf.http.config) = {
      path: "/users"
    };
    option (sebuf.http.method_headers) = {
      required_headers: [
        {
          name: "X-Request-ID"
          description: "Unique request identifier"
          type: "string"
          format: "uuid"
          required: true
        }
      ]
    };
  }
  
  rpc GetUser(GetUserRequest) returns (User) {
    option (sebuf.http.config) = {
      path: "/users/get"
    };
  }
}
```

The OpenAPI spec will reflect the actual HTTP paths and header parameters:

```yaml
paths:
  /api/v1/users:
    post:
      summary: CreateUser
      parameters:
        - name: X-API-Key
          in: header
          description: API authentication key
          required: true
          schema:
            type: string
            format: uuid
            example: "123e4567-e89b-12d3-a456-426614174000"
        - name: X-Request-ID
          in: header
          description: Unique request identifier
          required: true
          schema:
            type: string
            format: uuid
      requestBody:
        # ...
      responses:
        # ...
  /api/v1/users/get:
    post:
      summary: GetUser
      parameters:
        - name: X-API-Key
          in: header
          description: API authentication key
          required: true
          schema:
            type: string
            format: uuid
            example: "123e4567-e89b-12d3-a456-426614174000"
      requestBody:
        # ...
```

## Customization Options

### Document Information

Customize the generated OpenAPI document info:

```bash
# Set custom title and version
protoc --openapiv3_out=./docs \
       --openapiv3_opt=title="My Amazing API" \
       --openapiv3_opt=version="2.1.0" \
       api.proto
```

### Output Directory Structure

```bash
# Organize by version
protoc --openapiv3_out=./docs/v1 api/v1/*.proto
protoc --openapiv3_out=./docs/v2 api/v2/*.proto

# Separate files by service
protoc --openapiv3_out=./docs/auth auth_service.proto
protoc --openapiv3_out=./docs/users user_service.proto
```

### Multiple Formats

Generate both formats simultaneously:

```bash
# YAML for documentation
protoc --openapiv3_out=./docs api.proto

# JSON for tooling
protoc --openapiv3_out=./docs --openapiv3_opt=format=json api.proto
```

## Best Practices

### 1. Rich Documentation

Add comprehensive comments to your protobuf definitions:

```protobuf
// UserService provides comprehensive user management capabilities
// including CRUD operations, authentication, and profile management.
service UserService {
  // CreateUser registers a new user in the system.
  //
  // This method validates the user input, ensures email uniqueness,
  // and sends a welcome email if requested. The created user will
  // have a system-generated ID and creation timestamp.
  //
  // Returns the created user with all fields populated.
  rpc CreateUser(CreateUserRequest) returns (CreateUserResponse);
}

// User represents a registered user in the system
message User {
  // Unique identifier for the user (read-only)
  // Format: UUID v4
  // Example: "123e4567-e89b-12d3-a456-426614174000"
  string id = 1;
  
  // User's email address (must be unique)
  // Must be a valid email format
  // Example: "user@example.com"
  string email = 2;
  
  // Full display name of the user
  // Maximum length: 100 characters
  // Example: "John Doe"
  string name = 3;
}
```

### 2. Consistent Naming

Use consistent naming conventions:

```protobuf
// Good: Consistent service and method naming
service UserService {
  rpc CreateUser(CreateUserRequest) returns (CreateUserResponse);
  rpc GetUser(GetUserRequest) returns (GetUserResponse);
  rpc UpdateUser(UpdateUserRequest) returns (UpdateUserResponse);
  rpc DeleteUser(DeleteUserRequest) returns (DeleteUserResponse);
  rpc ListUsers(ListUsersRequest) returns (ListUsersResponse);
}

// Good: Clear request/response message naming
message CreateUserRequest {
  User user = 1;
  bool send_welcome_email = 2;
}

message CreateUserResponse {
  User user = 1;
  int64 created_at = 2;
}
```

### 3. Organize by Domain

Structure your protobuf files by business domain:

```
api/
├── auth/
│   ├── auth_service.proto
│   └── auth_types.proto
├── users/
│   ├── user_service.proto
│   └── user_types.proto
├── orders/
│   ├── order_service.proto
│   └── order_types.proto
└── common/
    ├── pagination.proto
    └── errors.proto
```

### 4. Version Management

Include version information in package names:

```protobuf
syntax = "proto3";
package mycompany.users.v1;

option go_package = "github.com/mycompany/api/users/v1;usersv1";

// Clear versioning in OpenAPI output
```

### 5. Error Handling Documentation

Document error scenarios in service comments:

```protobuf
service UserService {
  // GetUser retrieves a user by ID
  //
  // Errors:
  // - INVALID_ARGUMENT: User ID is empty or invalid format
  // - NOT_FOUND: User with the specified ID does not exist  
  // - PERMISSION_DENIED: Caller lacks permission to view this user
  // - INTERNAL: Database or system error occurred
  rpc GetUser(GetUserRequest) returns (GetUserResponse);
}
```

## Troubleshooting

### Common Issues

#### 1. Plugin Not Found
```
protoc-gen-openapiv3: program not found or is not executable
```

**Solution:**
```bash
# Ensure plugin is in PATH
export PATH=$PATH:$(go env GOPATH)/bin

# Reinstall plugin
go install github.com/SebastienMelki/sebuf/cmd/protoc-gen-openapiv3@latest
```

#### 2. No Output Generated
If no OpenAPI file is generated, check:

- **Service definitions**: Plugin only processes files with `service` definitions
- **Output directory**: Ensure the output directory exists and is writable
- **File permissions**: Check write permissions for the target directory

```bash
# Create output directory
mkdir -p docs

# Check permissions
ls -la docs/

# Generate with verbose output
protoc -v --openapiv3_out=./docs api.proto
```

#### 3. Missing Message Schemas
If message schemas are missing from the output:

- **Message usage**: Only messages used in service methods are included
- **Import statements**: Ensure all required messages are imported
- **Package structure**: Verify correct package and import paths

#### 4. Incorrect Type Mapping
If protobuf types aren't mapped correctly:

```protobuf
// Ensure proper type usage
message Example {
  string text = 1;        // ✅ Becomes string
  int32 number = 2;       // ✅ Becomes integer/int32
  repeated string list = 3; // ✅ Becomes array of strings
  map<string, string> meta = 4; // ✅ Becomes object with string values
}
```

### Validation and Testing

#### 1. Validate Generated Spec

```bash
# Install OpenAPI validator
npm install -g @apidevtools/swagger-cli

# Validate the generated spec
swagger-cli validate docs/api.yaml

# Bundle and dereference
swagger-cli bundle docs/api.yaml --outfile docs/api-bundled.yaml
```

#### 2. Test with Tools

```bash
# Test with Swagger UI
docker run -p 8080:8080 -v $(pwd)/docs:/app swaggerapi/swagger-ui

# Test with Postman
curl -X POST https://api.getpostman.com/import \
  -H "X-Api-Key: YOUR_API_KEY" \
  -F "file=@docs/api.yaml"

# Test with Insomnia
# Import docs/api.yaml directly in the Insomnia app
```

### Getting Help

- **Demo**: Try the [simple tutorial](../examples/)
- **Test cases**: Review `internal/openapiv3/` test files
- **Issues**: File a GitHub issue with your proto definition and expected output
- **Community**: Join GitHub Discussions for questions and tips

## Real-World Usage Examples

### API Gateway Integration

```yaml
# Generated OpenAPI can be imported into API gateways
# Kong, AWS API Gateway, Azure API Management, etc.

# Kong example
curl -X POST http://kong:8001/services \
  -d name=user-service \
  -d url=http://user-service:8080

curl -X POST http://kong:8001/services/user-service/plugins \
  -d name=openapi-validator \
  -d config.spec=@docs/user_api.yaml
```

### Client Generation Pipeline

```bash
#!/bin/bash
# generate-clients.sh

# Generate OpenAPI spec
protoc --openapiv3_out=./docs api/*.proto

# Generate TypeScript client
openapi-generator-cli generate \
  -i docs/api.yaml \
  -g typescript-fetch \
  -o clients/typescript \
  --additional-properties=npmName=@mycompany/api-client

# Generate Python client
openapi-generator-cli generate \
  -i docs/api.yaml \
  -g python \
  -o clients/python \
  --additional-properties=packageName=mycompany_api_client

# Generate Go client (alternative to protobuf)
openapi-generator-cli generate \
  -i docs/api.yaml \
  -g go \
  -o clients/go

echo "All clients generated successfully!"
```

### Documentation Website

```bash
# Generate static documentation site
npx redoc-cli bundle docs/api.yaml --output docs/index.html

# Or use GitBook, Docusaurus, etc.
# Most documentation platforms support OpenAPI imports
```

---

**Next:** Follow the complete workflow in our [Getting Started Guide](./getting-started.md)

**See also:**
- [HTTP Generation](./http-generation.md) - Generate HTTP handlers that match your OpenAPI spec
- [Validation Guide](./validation.md) - Comprehensive request validation
- [Simple Demo](./examples/) - Quick tutorial to get started