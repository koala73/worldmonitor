# Adding API Endpoints

All JSON API endpoints in WorldMonitor **must** use sebuf. Do not create standalone `api/*.js` files — the legacy pattern is deprecated and being removed.

This guide walks through adding a new RPC to an existing service and adding an entirely new service.

> **Important:** After modifying any `.proto` file, you **must** run `make generate` before building or pushing. The generated TypeScript files in `src/generated/` are checked into the repo and must stay in sync with the proto definitions. CI does not run generation yet — this is your responsibility until we add it to the pipeline (see [#200](https://github.com/koala73/worldmonitor/issues/200)).

## Prerequisites

You need **Go 1.21+** and **Node.js 18+** installed. Everything else is installed automatically:

```bash
make install    # one-time: installs buf, sebuf plugins, npm deps, proto deps
```

This installs:

- **buf** — proto linting, dependency management, and code generation orchestrator
- **protoc-gen-ts-client** — generates TypeScript client classes (from [sebuf](https://github.com/SebastienMelki/sebuf))
- **protoc-gen-ts-server** — generates TypeScript server handler interfaces (from sebuf)
- **protoc-gen-openapiv3** — generates OpenAPI v3 specs (from sebuf)
- **npm dependencies** — all Node.js packages

Run code generation from the repo root:

```bash
make generate   # regenerate all TypeScript + OpenAPI from protos
```

This produces three outputs per service:

- `src/generated/client/{domain}/v1/service_client.ts` — typed fetch client for the frontend
- `src/generated/server/{domain}/v1/service_server.ts` — handler interface + route factory for the backend
- `docs/api/{Domain}Service.openapi.yaml` + `.json` — OpenAPI v3 documentation

## Adding an RPC to an existing service

Example: adding `GetEarthquakeDetails` to `SeismologyService`.

### 1. Define the request/response messages

Create `proto/worldmonitor/seismology/v1/get_earthquake_details.proto`:

```protobuf
syntax = "proto3";
package worldmonitor.seismology.v1;

import "buf/validate/validate.proto";
import "worldmonitor/seismology/v1/earthquake.proto";

// GetEarthquakeDetailsRequest specifies which earthquake to retrieve.
message GetEarthquakeDetailsRequest {
  // USGS event identifier (e.g., "us7000abcd").
  string earthquake_id = 1 [
    (buf.validate.field).required = true,
    (buf.validate.field).string.min_len = 1,
    (buf.validate.field).string.max_len = 100
  ];
}

// GetEarthquakeDetailsResponse contains the full earthquake record.
message GetEarthquakeDetailsResponse {
  // The earthquake matching the requested ID.
  Earthquake earthquake = 1;
}
```

### 2. Add the RPC to the service definition

Edit `proto/worldmonitor/seismology/v1/service.proto`:

```protobuf
import "worldmonitor/seismology/v1/get_earthquake_details.proto";

service SeismologyService {
  // ... existing RPCs ...

  // GetEarthquakeDetails retrieves a single earthquake by its USGS event ID.
  rpc GetEarthquakeDetails(GetEarthquakeDetailsRequest) returns (GetEarthquakeDetailsResponse) {
    option (sebuf.http.config) = {path: "/get-earthquake-details"};
  }
}
```

### 3. Lint and generate

```bash
make check   # lint + generate in one step
```

At this point, `npx tsc --noEmit` will **fail** because the handler doesn't implement the new method yet. This is by design — the compiler enforces the contract.

### 4. Implement the handler

Create `server/worldmonitor/seismology/v1/get-earthquake-details.ts`:

```typescript
import type {
  SeismologyServiceHandler,
  ServerContext,
  GetEarthquakeDetailsRequest,
  GetEarthquakeDetailsResponse,
} from '../../../../src/generated/server/worldmonitor/seismology/v1/service_server';

export const getEarthquakeDetails: SeismologyServiceHandler['getEarthquakeDetails'] = async (
  _ctx: ServerContext,
  req: GetEarthquakeDetailsRequest,
): Promise<GetEarthquakeDetailsResponse> => {
  const response = await fetch(
    `https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/${req.earthquakeId}.geojson`,
  );
  if (!response.ok) {
    throw new Error(`USGS API error: ${response.status}`);
  }
  const f: any = await response.json();
  return {
    earthquake: {
      id: f.id,
      place: f.properties.place || '',
      magnitude: f.properties.mag ?? 0,
      depthKm: f.geometry.coordinates[2] ?? 0,
      location: {
        latitude: f.geometry.coordinates[1],
        longitude: f.geometry.coordinates[0],
      },
      occurredAt: f.properties.time,
      sourceUrl: f.properties.url || '',
    },
  };
};
```

### 5. Wire it into the handler re-export

Edit `server/worldmonitor/seismology/v1/handler.ts`:

```typescript
import type { SeismologyServiceHandler } from '../../../../src/generated/server/worldmonitor/seismology/v1/service_server';

import { listEarthquakes } from './list-earthquakes';
import { getEarthquakeDetails } from './get-earthquake-details';

export const seismologyHandler: SeismologyServiceHandler = {
  listEarthquakes,
  getEarthquakeDetails,
};
```

### 6. Verify

```bash
npx tsc --noEmit   # should pass with zero errors
```

The route is already live. `createSeismologyServiceRoutes()` picks up the new RPC automatically — no changes needed to `api/[[...path]].ts` or `vite.config.ts`.

### 7. Check the generated docs

Open `docs/api/SeismologyService.openapi.yaml` — the new endpoint should appear with all validation constraints from your proto annotations.

## Adding a new service

Example: adding a `SanctionsService`.

### 1. Create the proto directory

```
proto/worldmonitor/sanctions/v1/
```

### 2. Define entity messages

Create `proto/worldmonitor/sanctions/v1/sanctions_entry.proto`:

```protobuf
syntax = "proto3";
package worldmonitor.sanctions.v1;

import "buf/validate/validate.proto";
import "sebuf/http/annotations.proto";

// SanctionsEntry represents a single entity on a sanctions list.
message SanctionsEntry {
  // Unique identifier.
  string id = 1 [
    (buf.validate.field).required = true,
    (buf.validate.field).string.min_len = 1
  ];
  // Name of the sanctioned entity or individual.
  string name = 2;
  // Issuing authority (e.g., "OFAC", "EU", "UN").
  string authority = 3;
  // ISO 3166-1 alpha-2 country code of the target.
  string country_code = 4;
  // Date the sanction was imposed, as Unix epoch milliseconds.
  int64 imposed_at = 5 [(sebuf.http.int64_encoding) = INT64_ENCODING_NUMBER];
}
```

### 3. Define request/response messages

Create `proto/worldmonitor/sanctions/v1/list_sanctions.proto`:

```protobuf
syntax = "proto3";
package worldmonitor.sanctions.v1;

import "buf/validate/validate.proto";
import "worldmonitor/core/v1/pagination.proto";
import "worldmonitor/sanctions/v1/sanctions_entry.proto";

// ListSanctionsRequest specifies filters for sanctions data.
message ListSanctionsRequest {
  // Filter by issuing authority (e.g., "OFAC"). Empty returns all.
  string authority = 1;
  // Filter by country code.
  string country_code = 2 [(buf.validate.field).string.max_len = 2];
  // Pagination parameters.
  worldmonitor.core.v1.PaginationRequest pagination = 3;
}

// ListSanctionsResponse contains the matching sanctions entries.
message ListSanctionsResponse {
  // The list of sanctions entries.
  repeated SanctionsEntry entries = 1;
  // Pagination metadata.
  worldmonitor.core.v1.PaginationResponse pagination = 2;
}
```

### 4. Define the service

Create `proto/worldmonitor/sanctions/v1/service.proto`:

```protobuf
syntax = "proto3";
package worldmonitor.sanctions.v1;

import "sebuf/http/annotations.proto";
import "worldmonitor/sanctions/v1/list_sanctions.proto";

// SanctionsService provides APIs for international sanctions monitoring.
service SanctionsService {
  option (sebuf.http.service_config) = {base_path: "/api/sanctions/v1"};

  // ListSanctions retrieves sanctions entries matching the given filters.
  rpc ListSanctions(ListSanctionsRequest) returns (ListSanctionsResponse) {
    option (sebuf.http.config) = {path: "/list-sanctions"};
  }
}
```

### 5. Generate

```bash
make check   # lint + generate in one step
```

### 6. Implement the handler

Create the handler directory and files:

```
server/worldmonitor/sanctions/v1/
├── handler.ts               # thin re-export
└── list-sanctions.ts        # RPC implementation
```

`server/worldmonitor/sanctions/v1/list-sanctions.ts`:
```typescript
import type {
  SanctionsServiceHandler,
  ServerContext,
  ListSanctionsRequest,
  ListSanctionsResponse,
} from '../../../../src/generated/server/worldmonitor/sanctions/v1/service_server';

export const listSanctions: SanctionsServiceHandler['listSanctions'] = async (
  _ctx: ServerContext,
  req: ListSanctionsRequest,
): Promise<ListSanctionsResponse> => {
  // Your implementation here — fetch from upstream API, transform to proto shape
  return { entries: [], pagination: undefined };
};
```

`server/worldmonitor/sanctions/v1/handler.ts`:
```typescript
import type { SanctionsServiceHandler } from '../../../../src/generated/server/worldmonitor/sanctions/v1/service_server';

import { listSanctions } from './list-sanctions';

export const sanctionsHandler: SanctionsServiceHandler = {
  listSanctions,
};
```

### 7. Register the service in the gateway

Edit `api/[[...path]].js` — add the import and mount the routes:

```typescript
import { createSanctionsServiceRoutes } from '../src/generated/server/worldmonitor/sanctions/v1/service_server';
import { sanctionsHandler } from './server/worldmonitor/sanctions/v1/handler';

const allRoutes = [
  // ... existing routes ...
  ...createSanctionsServiceRoutes(sanctionsHandler, serverOptions),
];
```

### 8. Register in the Vite dev server

Edit `vite.config.ts` — add the lazy import and route mount inside the `sebufApiPlugin()` function. Follow the existing pattern (search for any other service to see the exact locations).

### 9. Create the frontend service wrapper

Create `src/services/sanctions.ts`:

```typescript
import {
  SanctionsServiceClient,
  type SanctionsEntry,
  type ListSanctionsResponse,
} from '@/generated/client/worldmonitor/sanctions/v1/service_client';
import { createCircuitBreaker } from '@/utils';

export type { SanctionsEntry };

const client = new SanctionsServiceClient('', { fetch: fetch.bind(globalThis) });
const breaker = createCircuitBreaker<ListSanctionsResponse>({ name: 'Sanctions' });

const emptyFallback: ListSanctionsResponse = { entries: [] };

export async function fetchSanctions(authority?: string): Promise<SanctionsEntry[]> {
  const response = await breaker.execute(async () => {
    return client.listSanctions({ authority: authority ?? '', countryCode: '', pagination: undefined });
  }, emptyFallback);
  return response.entries;
}
```

### 10. Verify

```bash
npx tsc --noEmit   # zero errors
```

## Proto conventions

These conventions are enforced across the codebase. Follow them for consistency.

### File naming

- One file per message type: `earthquake.proto`, `sanctions_entry.proto`
- One file per RPC pair: `list_earthquakes.proto`, `get_earthquake_details.proto`
- Service definition: `service.proto`
- Use `snake_case` for file names and field names

### Time fields

Always use `int64` with Unix epoch milliseconds. Never use `google.protobuf.Timestamp`.

Always add the `INT64_ENCODING_NUMBER` annotation so TypeScript gets `number` instead of `string`:

```protobuf
int64 occurred_at = 6 [(sebuf.http.int64_encoding) = INT64_ENCODING_NUMBER];
```

### Validation annotations

Import `buf/validate/validate.proto` and annotate fields at the proto level. These constraints flow through to the generated OpenAPI spec automatically.

Common patterns:

```protobuf
// Required string with length bounds
string id = 1 [
  (buf.validate.field).required = true,
  (buf.validate.field).string.min_len = 1,
  (buf.validate.field).string.max_len = 100
];

// Numeric range (e.g., score 0-100)
double risk_score = 2 [
  (buf.validate.field).double.gte = 0,
  (buf.validate.field).double.lte = 100
];

// Non-negative value
double min_magnitude = 3 [(buf.validate.field).double.gte = 0];

// Coordinate bounds (prefer using core.v1.GeoCoordinates instead)
double latitude = 1 [
  (buf.validate.field).double.gte = -90,
  (buf.validate.field).double.lte = 90
];
```

### Shared core types

Reuse these instead of redefining:

| Type | Import | Use for |
|------|--------|---------|
| `GeoCoordinates` | `worldmonitor/core/v1/geo.proto` | Any lat/lon location (has built-in -90/90 and -180/180 bounds) |
| `BoundingBox` | `worldmonitor/core/v1/geo.proto` | Spatial filtering |
| `TimeRange` | `worldmonitor/core/v1/time.proto` | Time-based filtering (has `INT64_ENCODING_NUMBER`) |
| `PaginationRequest` | `worldmonitor/core/v1/pagination.proto` | Request pagination (has page_size 1-100 constraint) |
| `PaginationResponse` | `worldmonitor/core/v1/pagination.proto` | Response pagination metadata |

### Comments

buf lint enforces comments on all messages, fields, services, RPCs, and enum values. Every proto element must have a `//` comment. This is not optional — `buf lint` will fail without them.

### Route paths

- Service base path: `/api/{domain}/v1`
- RPC path: `/{verb}-{noun}` in kebab-case (e.g., `/list-earthquakes`, `/get-vessel-snapshot`)

### Handler typing

Always type the handler function against the generated interface using indexed access:

```typescript
export const listSanctions: SanctionsServiceHandler['listSanctions'] = async (
  _ctx: ServerContext,
  req: ListSanctionsRequest,
): Promise<ListSanctionsResponse> => {
  // ...
};
```

This ensures the compiler catches any mismatch between your implementation and the proto contract.

### Client construction

Always pass `{ fetch: fetch.bind(globalThis) }` when creating clients:

```typescript
const client = new SanctionsServiceClient('', { fetch: fetch.bind(globalThis) });
```

The empty string base URL works because both Vite dev server and Vercel serve the API on the same origin. The `fetch.bind(globalThis)` is required for Tauri compatibility.

## Generated documentation

Every time you run `make generate`, OpenAPI v3 specs are generated for each service:

- `docs/api/{Domain}Service.openapi.yaml` — human-readable YAML
- `docs/api/{Domain}Service.openapi.json` — machine-readable JSON

These specs include:

- All endpoints with request/response schemas
- Validation constraints from `buf.validate` annotations (min/max, required fields, ranges)
- Field descriptions from proto comments
- Error response schemas (400 validation errors, 500 server errors)

You do not need to write or maintain OpenAPI specs by hand. They are generated artifacts. If you need to change the API documentation, change the proto and regenerate.
