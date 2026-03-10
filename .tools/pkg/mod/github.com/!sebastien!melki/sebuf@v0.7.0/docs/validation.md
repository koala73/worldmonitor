# Validation

sebuf provides comprehensive automatic validation for both HTTP headers and request bodies, powered by [protovalidate](https://github.com/bufbuild/protovalidate) for body validation and custom middleware for header validation, giving you production-ready validation with zero configuration.

## Quick Start

### Request Body Validation

Add validation rules to your protobuf messages using `buf.validate` annotations:

```protobuf
syntax = "proto3";

import "buf/validate/validate.proto";

message CreateUserRequest {
  // Name must be between 2 and 100 characters
  string name = 1 [(buf.validate.field).string = {
    min_len: 2,
    max_len: 100
  }];
  
  // Email must be valid
  string email = 2 [(buf.validate.field).string.email = true];
  
  // Age must be between 18 and 120
  int32 age = 3 [(buf.validate.field).int32 = {
    gte: 18,
    lte: 120
  }];
}
```

### Header Validation

Add header validation to your services using sebuf annotations:

```protobuf
import "sebuf/http/headers.proto";

service UserService {
  option (sebuf.http.service_headers) = {
    required_headers: [
      {
        name: "X-API-Key"
        type: "string"
        format: "uuid"
        required: true
        description: "API authentication key"
      }
    ]
  };
  
  rpc CreateUser(CreateUserRequest) returns (User);
}
```

That's it! Both header and body validation happen automatically in your HTTP handlers.

## Features

- ✅ **Zero configuration** - Validation works automatically
- ✅ **Comprehensive coverage** - Both headers and request bodies validated
- ✅ **All protovalidate rules** - Full compatibility with buf.validate ecosystem for body validation
- ✅ **Header type validation** - Support for string, integer, number, boolean, array types
- ✅ **Header format validation** - Built-in validators for UUID, email, datetime formats
- ✅ **Performance optimized** - Cached validator instances
- ✅ **Structured error responses** - JSON or protobuf ValidationError with field-level details
- ✅ **Content-type aware** - Error format matches client's requested content type
- ✅ **Fail-fast validation** - Headers validated before body for efficiency

## Request Body Validation Rules

### String Validation

```protobuf
message StringValidationExample {
  // Length constraints
  string name = 1 [(buf.validate.field).string = {
    min_len: 1,
    max_len: 50
  }];
  
  // Email validation
  string email = 2 [(buf.validate.field).string.email = true];
  
  // UUID validation
  string id = 3 [(buf.validate.field).string.uuid = true];
  
  // Pattern matching (regex)
  string phone = 4 [(buf.validate.field).string.pattern = "^\\+?[1-9]\\d{1,14}$"];
  
  // Enum-like validation (allowed values)
  string status = 5 [(buf.validate.field).string = {
    in: ["active", "inactive", "pending"]
  }];
  
  // URL validation
  string website = 6 [(buf.validate.field).string.uri = true];
}
```

### Numeric Validation

```protobuf
message NumericValidationExample {
  // Integer range
  int32 age = 1 [(buf.validate.field).int32 = {
    gte: 0,
    lte: 150
  }];
  
  // Exact value
  int32 version = 2 [(buf.validate.field).int32.const = 1];
  
  // List of allowed values
  int32 priority = 3 [(buf.validate.field).int32 = {
    in: [1, 2, 3, 4, 5]
  }];
  
  // Float validation
  float score = 4 [(buf.validate.field).float = {
    gte: 0.0,
    lte: 100.0
  }];
}
```

### Collection Validation

```protobuf
message CollectionValidationExample {
  // Repeated field size
  repeated string tags = 1 [(buf.validate.field).repeated = {
    min_items: 1,
    max_items: 10
  }];
  
  // Map validation
  map<string, string> metadata = 2 [(buf.validate.field).map = {
    min_pairs: 1,
    max_pairs: 20
  }];
  
  // Nested message validation
  repeated UserInfo users = 3 [(buf.validate.field).repeated.min_items = 1];
}
```

### Message Validation

```protobuf
message MessageValidationExample {
  // Required field (non-zero/non-empty)
  string required_field = 1 [(buf.validate.field).required = true];
  
  // Skip validation for this field
  string internal_field = 2 [(buf.validate.field).ignore = IGNORE_ALWAYS];
}
```

## Header Validation

### Service-Level Headers

Headers defined at the service level apply to all RPCs in that service:

```protobuf
service APIService {
  option (sebuf.http.service_headers) = {
    required_headers: [
      {
        name: "X-API-Key"
        description: "API authentication key"
        type: "string"
        format: "uuid"
        required: true
        example: "123e4567-e89b-12d3-a456-426614174000"
      },
      {
        name: "X-Tenant-ID"
        description: "Tenant identifier"
        type: "integer"
        required: true
      },
      {
        name: "X-Debug-Mode"
        description: "Enable debug mode"
        type: "boolean"
        required: false
      }
    ]
  };
}
```

### Method-Level Headers

Headers can be specified per RPC method, overriding service-level headers with the same name:

```protobuf
rpc CreateResource(CreateResourceRequest) returns (Resource) {
  option (sebuf.http.method_headers) = {
    required_headers: [
      {
        name: "X-Request-ID"
        type: "string"
        format: "uuid"
        required: true
      },
      {
        name: "X-Idempotency-Key"
        description: "Idempotency key for safe retries"
        type: "string"
        required: true
      }
    ]
  };
}
```

### Supported Header Types and Formats

| Type | Formats | Description |
|------|---------|-------------|
| `string` | `uuid`, `email`, `date-time`, `date`, `time` | Text with optional format validation |
| `integer` | - | Whole numbers |
| `number` | - | Decimal numbers |
| `boolean` | - | `true` or `false` values |
| `array` | - | Comma-separated values |

### Header Validation Examples

```protobuf
// Comprehensive header validation example
service SecureAPI {
  option (sebuf.http.service_headers) = {
    required_headers: [
      // UUID validation
      {
        name: "X-Trace-ID"
        description: "Trace ID for request tracing"
        type: "string"
        format: "uuid"
        required: true
        example: "123e4567-e89b-12d3-a456-426614174000"
      },
      // Email validation
      {
        name: "X-Admin-Email"
        description: "Admin contact email"
        type: "string"
        format: "email"
        required: false
        example: "admin@example.com"
      },
      // Date-time validation
      {
        name: "X-Request-Time"
        description: "Request timestamp"
        type: "string"
        format: "date-time"
        required: true
        example: "2024-01-15T10:30:00Z"
      },
      // Integer type
      {
        name: "X-Rate-Limit"
        description: "Rate limit override"
        type: "integer"
        required: false
        example: "100"
      },
      // String type
      {
        name: "X-API-Version"
        description: "API version"
        type: "string"
        required: false
        example: "v2"
      },
      // Array type
      {
        name: "X-Features"
        type: "array"
        required: false
        description: "Comma-separated feature flags"
        example: "feature1,feature2"
      }
    ]
  };
}
```

## Error Handling

When validation fails, sebuf returns an HTTP 400 Bad Request with a structured error response. The response format respects the client's `Content-Type` header, returning either JSON or protobuf. Headers are validated before the request body.

### Structured Error Response Format

Validation errors are returned as a `ValidationError` message containing field-level violations:

```protobuf
message ValidationError {
  repeated FieldViolation violations = 1;
}

message FieldViolation {
  string field = 1;       // Field that failed validation
  string description = 2; // Description of the violation
}
```

### Header Validation Errors

```bash
# Missing required header
curl -X POST /api/users \
  -H "Content-Type: application/json" \
  -d '{"name": "John"}'
# Returns: 400 Bad Request
# Body: 
{
  "violations": [{
    "field": "X-API-Key",
    "description": "required header 'X-API-Key' is missing"
  }]
}

# Invalid header format (UUID)
curl -X POST /api/users \
  -H "Content-Type: application/json" \
  -H "X-API-Key: not-a-uuid" \
  -d '{"name": "John"}'
# Returns: 400 Bad Request
# Body:
{
  "violations": [{
    "field": "X-API-Key",
    "description": "header 'X-API-Key' validation failed: invalid UUID format"
  }]
}

# Invalid header type (expecting integer)
curl -X POST /api/users \
  -H "Content-Type: application/json" \
  -H "X-API-Key: 123e4567-e89b-12d3-a456-426614174000" \
  -H "X-Tenant-ID: abc" \
  -d '{"name": "John"}'
# Returns: 400 Bad Request
# Body:
{
  "violations": [{
    "field": "X-Tenant-ID",
    "description": "header 'X-Tenant-ID' validation failed: value is not a valid integer"
  }]
}
```

### Body Validation Errors

```bash
# Invalid email
curl -X POST /api/users \
  -H "Content-Type: application/json" \
  -H "X-API-Key: 123e4567-e89b-12d3-a456-426614174000" \
  -d '{"email": "invalid"}'
# Returns: 400 Bad Request
# Body:
{
  "violations": [{
    "field": "email",
    "description": "value must be a valid email address"
  }]
}

# Multiple validation failures
curl -X POST /api/users \
  -H "Content-Type: application/json" \
  -H "X-API-Key: 123e4567-e89b-12d3-a456-426614174000" \
  -d '{"name": "J", "email": "invalid", "age": 200}'
# Returns: 400 Bad Request
# Body:
{
  "violations": [
    {
      "field": "name",
      "description": "value length must be at least 2 runes"
    },
    {
      "field": "email",
      "description": "value must be a valid email address"
    },
    {
      "field": "age",
      "description": "value must be less than or equal to 120"
    }
  ]
}
```

### Binary Response Format

When using protobuf content type, errors are returned as binary protobuf:

```bash
curl -X POST /api/users \
  -H "Content-Type: application/x-protobuf" \
  -H "X-API-Key: invalid" \
  --data-binary @request.pb
# Returns: 400 Bad Request with binary ValidationError protobuf
```

## Client Error Handling

sebuf error types implement Go's standard `error` interface, enabling seamless error handling when using sebuf as a client library.

### Automatic Error Interface Implementation

The HTTP generator **automatically implements the Go `error` interface** for any protobuf message whose name ends with "Error". This includes the built-in `ValidationError` and `Error` types, as well as any custom error types you define.

**Built-in Error Types:**
- `ValidationError` - Validation failures with field-level details
- `Error` - General service errors with custom messages  

**Custom Error Types:**
You can define your own error types in protobuf and they automatically get error interface support:

```protobuf
message AuthenticationError {
  string token = 1;
  string reason = 2;
}

message RateLimitError {
  int32 requests_remaining = 1;
  int64 reset_time = 2;
}
```

All error types provide `Error()` methods that return formatted error messages:

```go
import (
    "errors"
    sebufhttp "github.com/SebastienMelki/sebuf/http"
)

// After receiving an error response from a sebuf API
func handleAPIError(err error) {
    // Check for validation errors specifically
    var validationErr *sebufhttp.ValidationError
    if errors.As(err, &validationErr) {
        fmt.Printf("Validation failed: %s\n", validationErr.Error())
        // Output: "validation error: email: must be a valid email address"
        
        // Access individual violations
        for _, violation := range validationErr.Violations {
            fmt.Printf("  - %s: %s\n", violation.Field, violation.Description)
        }
        return
    }
    
    // Check for general sebuf errors
    var sebufErr *sebufhttp.Error
    if errors.As(err, &sebufErr) {
        fmt.Printf("Service error: %s\n", sebufErr.Error())
        // Output: "user not found"
        return
    }
    
    // Handle other error types
    fmt.Printf("Unknown error: %s\n", err.Error())
}
```

### Error Message Formatting

**ValidationError messages:**
- Single violation: `"validation error: field: description"`
- Multiple violations: `"validation error: [field1: desc1, field2: desc2]"`
- No violations: `"validation error: no violations"`

**Error messages:**
- Returns the `Message` field directly
- Empty message: `"error: empty message"`

### Integration with Standard Go Error Handling

```go
// Works with all standard Go error patterns
func processUserData(data UserData) error {
    resp, err := apiClient.CreateUser(ctx, data)
    if err != nil {
        // Standard error handling
        var validationErr *sebufhttp.ValidationError
        if errors.As(err, &validationErr) {
            // Handle validation errors specifically
            return fmt.Errorf("invalid user data: %w", validationErr)
        }
        
        // Can be wrapped with additional context
        return fmt.Errorf("failed to create user: %w", err)
    }
    
    return nil
}

// Error comparison with errors.Is
func isValidationError(err error) bool {
    var validationErr *sebufhttp.ValidationError
    return errors.As(err, &validationErr)
}
```

### TypeScript Error Handling

The TypeScript generators automatically include interfaces for proto messages ending with "Error", enabling type-safe custom error handling:

```typescript
import { ApiError, ValidationError, type NotFoundError } from "./generated/proto/service_client.ts";

try {
  await client.getUser({ id: "not-found" });
} catch (e) {
  if (e instanceof ValidationError) {
    // Built-in: header/body validation failures (400)
    for (const v of e.violations) {
      console.log(`${v.field}: ${v.description}`);
    }
  } else if (e instanceof ApiError) {
    // Custom proto-defined errors: parse body using generated interface
    if (e.statusCode === 404) {
      const err = JSON.parse(e.body) as NotFoundError;
      console.log(err.resourceType, err.resourceId);
    }
  }
}
```

## Advanced Usage

### Custom Error Messages

Use CEL expressions for custom validation logic:

```protobuf
message AdvancedValidation {
  string password = 1 [(buf.validate.field).string = {
    min_len: 8,
    pattern: "^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d).*$"
  }];
  
  // Custom CEL validation
  string username = 2 [(buf.validate.field).cel = {
    id: "username.unique",
    message: "Username must be unique and start with letter",
    expression: "this.matches('^[a-zA-Z][a-zA-Z0-9_]*$')"
  }];
}
```

### Conditional Validation

```protobuf
message ConditionalValidation {
  string type = 1;
  
  // Only validate email if type is "email"
  string contact = 2 [(buf.validate.field).cel = {
    id: "contact.conditional",
    expression: "this.type != 'email' || this.contact.isEmail()"
  }];
}
```

## Performance

Validation is highly optimized:

- **Cached validators**: Validator instances for body validation are created once and reused
- **Efficient header checking**: Headers validated in a single pass before body processing
- **No reflection overhead**: Validation rules are pre-compiled
- **Minimal allocations**: Only allocates on validation errors
- **Sub-microsecond latency**: After initial warm-up
- **Fail-fast**: Headers validated first to avoid unnecessary body parsing

## Compatibility

sebuf validation is fully compatible with the protovalidate ecosystem:

- **buf CLI**: Use buf validate commands for body validation rules
- **IDE support**: Validation rules show in proto IDE plugins  
- **Other languages**: Same body validation rules work with protovalidate for Python, Java, etc.
- **OpenAPI**: Header validations automatically appear in generated OpenAPI specs
- **Migration**: Uses standard buf.validate annotations for body validation

## Best Practices

1. **Validate at the boundary**: Add validation to both headers and request messages
2. **Be specific**: Use the most specific validation rule (email vs pattern, UUID format vs string)
3. **Layer validation**: Use headers for auth/metadata, body for business data
4. **Consider UX**: Validation errors are shown to users - make them helpful
5. **Test edge cases**: Test validation with boundary values and missing headers
6. **Document constraints**: Include validation info in API documentation
7. **Use service-level headers**: Define common headers once at service level
8. **Override when needed**: Use method-level headers for specific requirements

## Troubleshooting

**Body validation not working?**
- Ensure you're importing `"buf/validate/validate.proto"`
- Check that your message fields have validation annotations
- Regenerate your code after adding validation rules

**Header validation not working?**
- Ensure you're importing `"sebuf/http/headers.proto"`
- Check that headers are defined in service or method options
- Verify header names match exactly (case-sensitive)
- Regenerate your code after adding header annotations

**Performance concerns?**
- Validation overhead is minimal (<1μs per request after warm-up)
- Header validation is done in a single pass
- Body validators are cached automatically
- No code generation required for validation logic

**Debugging validation issues?**
- Headers are validated first - check header errors before body errors
- Use curl with -v flag to see all headers being sent
- Check generated OpenAPI spec to verify header requirements

**Need help?**
- Check the [protovalidate documentation](https://github.com/bufbuild/protovalidate) for body validation
- See the [validation-showcase example](../examples/validation-showcase/) for comprehensive validation patterns
- Review [http-generation.md](./http-generation.md#header-validation) for header details
- Open an issue on GitHub

## Examples

- **[validation-showcase](../examples/validation-showcase/)** - Comprehensive buf.validate patterns (string, numeric, array, map, nested)
- **[multi-service-api](../examples/multi-service-api/)** - Service and method-level header validation