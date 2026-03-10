import {
  NoteServiceClient,
  ValidationError,
  ApiError,
  type Note,
  type NotFoundError,
  type LoginError,
} from "./generated/proto/note_service_client.ts";

// ============================================================================
// Terminal colors
// ============================================================================

const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  white: "\x1b[37m",
  bgCyan: "\x1b[46m\x1b[30m",
  bgMagenta: "\x1b[45m\x1b[37m",
  bgYellow: "\x1b[43m\x1b[30m",
  bgBlue: "\x1b[44m\x1b[37m",
  bgRed: "\x1b[41m\x1b[37m",
};

function methodColor(method: string): string {
  switch (method) {
    case "GET": return c.bgCyan;
    case "POST": return c.bgMagenta;
    case "PUT": return c.bgYellow;
    case "PATCH": return c.bgBlue;
    case "DELETE": return c.bgRed;
    default: return c.dim;
  }
}

function statusColor(status: number): string {
  if (status < 300) return c.green;
  if (status < 400) return c.cyan;
  if (status < 500) return c.yellow;
  return c.red;
}

function prettyJson(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

function indent(text: string, prefix: string = "    "): string {
  return text.split("\n").map((l) => prefix + l).join("\n");
}

// ============================================================================
// Logging fetch wrapper — shows every request/response in the terminal
// ============================================================================

let reqCounter = 0;

function createLoggingFetch(): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const reqId = ++reqCounter;
    const method = init?.method ?? "GET";
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const urlObj = new URL(url);
    const path = urlObj.pathname + urlObj.search;

    // ── Log request ──
    console.log(`  ${c.dim}┌─${c.reset} ${methodColor(method)} ${method} ${c.reset} ${c.white}${path}${c.reset}`);

    // Headers
    const hdrs = init?.headers as Record<string, string> | undefined;
    if (hdrs) {
      const interesting = Object.entries(hdrs).filter(
        ([k]) => !["content-type"].includes(k.toLowerCase()),
      );
      if (interesting.length > 0) {
        console.log(`  ${c.dim}│${c.reset}  ${c.dim}Headers:${c.reset}`);
        for (const [k, v] of interesting) {
          console.log(`  ${c.dim}│${c.reset}    ${c.cyan}${k}${c.reset}: ${v}`);
        }
      }
    }

    // Body
    if (init?.body) {
      console.log(`  ${c.dim}│${c.reset}  ${c.dim}Body:${c.reset}`);
      try {
        const parsed = JSON.parse(String(init.body));
        console.log(indent(prettyJson(parsed), `  ${c.dim}│${c.reset}    `));
      } catch {
        console.log(`  ${c.dim}│${c.reset}    ${init.body}`);
      }
    }

    const t0 = performance.now();
    const resp = await fetch(input, init);
    const duration = Math.round(performance.now() - t0);

    // Clone so we can read the body for logging AND return it for the client
    const clone = resp.clone();
    const body = await clone.text();

    // ── Log response ──
    const sc = statusColor(resp.status);
    console.log(`  ${c.dim}└─${c.reset} ${sc}${c.bold}${resp.status}${c.reset} ${c.dim}(${duration}ms)${c.reset}`);
    if (body) {
      try {
        const parsed = JSON.parse(body);
        console.log(indent(prettyJson(parsed), `     `));
      } catch {
        console.log(`     ${body}`);
      }
    }
    console.log("");

    return resp;
  };
}

// ============================================================================
// Section 1: Client Setup
// ============================================================================

function createClient(): NoteServiceClient {
  console.log(`${c.bold}═══════════════════════════════════════════════════════${c.reset}`);
  console.log(`${c.bold}  sebuf TypeScript Client Demo${c.reset}`);
  console.log(`${c.bold}═══════════════════════════════════════════════════════${c.reset}`);
  console.log("");

  const client = new NoteServiceClient("http://localhost:3000", {
    apiKey: "550e8400-e29b-41d4-a716-446655440000",
    tenantId: "42",
    fetch: createLoggingFetch(),
  });
  console.log(`  ${c.dim}Service headers:${c.reset}`);
  console.log(`    ${c.cyan}X-API-Key${c.reset}:   550e8400-e29b-41d4-a716-446655440000`);
  console.log(`    ${c.cyan}X-Tenant-ID${c.reset}: 42`);
  console.log("");

  return client;
}

// ============================================================================
// Section 2: CRUD Operations
// ============================================================================

async function demoCrud(client: NoteServiceClient) {
  console.log(`${c.bold}── CRUD Operations ──────────────────────────────────${c.reset}`);
  console.log("");

  // LIST
  console.log(`${c.green}▸ ListNotes${c.reset}`);
  const allNotes = await client.listNotes({} as any);

  // GET
  console.log(`${c.green}▸ GetNote${c.reset} ${c.dim}(note-1)${c.reset}`);
  const note1 = await client.getNote({ id: "note-1" });

  // CREATE
  console.log(`${c.green}▸ CreateNote${c.reset}`);
  const created = await client.createNote(
    {
      title: "Deploy to staging",
      content: "Run integration tests before prod",
      priority: "PRIORITY_HIGH",
      tags: [
        { name: "devops", color: "#06b6d4" },
        { name: "backend", color: "#3b82f6" },
      ],
      metadata: { environment: "staging" },
      dueDate: "2025-07-01",
    },
    { requestId: "req-001" },
  );

  // UPDATE
  console.log(`${c.green}▸ UpdateNote${c.reset} ${c.dim}(${created.id})${c.reset}`);
  const updated = await client.updateNote(
    {
      id: created.id,
      title: "Deploy to staging (approved)",
      content: "Integration tests passed",
      priority: "PRIORITY_URGENT",
      status: "STATUS_IN_PROGRESS",
      tags: created.tags,
      metadata: { environment: "staging", approved: "true" },
      dueDate: "2025-06-30",
    },
    { idempotencyKey: "idem-001" },
  );

  // ARCHIVE
  console.log(`${c.green}▸ ArchiveNote${c.reset} ${c.dim}(note-1)${c.reset}`);
  const archived = await client.archiveNote({ id: "note-1" });

  // DELETE
  console.log(`${c.green}▸ DeleteNote${c.reset} ${c.dim}(${created.id})${c.reset}`);
  const deleted = await client.deleteNote({ id: created.id });
}

// ============================================================================
// Section 3: Query Parameters & Unwrap
// ============================================================================

async function demoQueries(client: NoteServiceClient) {
  console.log(`${c.bold}── Query Parameters & Unwrap ────────────────────────${c.reset}`);
  console.log("");

  // Filter by status
  console.log(`${c.green}▸ ListNotes${c.reset} ${c.dim}(status=pending)${c.reset}`);
  const pending = await client.listNotes({ status: "pending" } as any);

  // Pagination
  console.log(`${c.green}▸ ListNotes${c.reset} ${c.dim}(limit=2, offset=0)${c.reset}`);
  const page = await client.listNotes({ limit: 2, offset: 0 } as any);

  // Unwrap: getNotesByTag returns Note[] directly
  console.log(`${c.green}▸ GetNotesByTag${c.reset} ${c.dim}(tag=backend) → unwrapped Note[]${c.reset}`);
  const backendNotes: Note[] = await client.getNotesByTag({ tag: "backend" });
}

// ============================================================================
// Section 4: Error Handling
// ============================================================================

async function demoErrors(client: NoteServiceClient) {
  console.log(`${c.bold}── Error Handling ──────────────────────────────────${c.reset}`);
  console.log("");

  // Header validation: missing required header
  console.log(`${c.yellow}▸ Missing X-Request-ID header on CreateNote${c.reset}`);
  try {
    await client.createNote(
      { title: "No header", content: "Should fail", priority: "PRIORITY_LOW", tags: [], metadata: {} },
    );
  } catch (e) {
    if (e instanceof ValidationError) {
      console.log(`  ${c.red}✗ ValidationError${c.reset}: ${e.violations.map((v) => `${v.field}: ${v.description}`).join(", ")}`);
      console.log("");
    }
  }

  // Not found error — parse using generated NotFoundError interface
  console.log(`${c.yellow}▸ GetNote (non-existent) → proto-defined NotFoundError${c.reset}`);
  try {
    await client.getNote({ id: "does-not-exist" });
  } catch (e) {
    if (e instanceof ApiError) {
      const body = JSON.parse(e.body) as NotFoundError;
      console.log(`  ${c.red}✗ ApiError ${e.statusCode}${c.reset} — parsed as ${c.bold}NotFoundError${c.reset}:`);
      console.log(`    resourceType: ${c.white}${body.resourceType}${c.reset}`);
      console.log(`    resourceId:   ${c.white}${body.resourceId}${c.reset}`);
      console.log("");
    }
  }

  // Login error — parse using generated LoginError interface
  console.log(`${c.yellow}▸ ListNotes (expired API key) → proto-defined LoginError${c.reset}`);
  try {
    await client.listNotes({} as any, {
      apiKey: "deadbeef-dead-dead-dead-deaddeaddead",
    });
  } catch (e) {
    if (e instanceof ApiError) {
      const body = JSON.parse(e.body) as LoginError;
      console.log(`  ${c.red}✗ ApiError ${e.statusCode}${c.reset} — parsed as ${c.bold}LoginError${c.reset}:`);
      console.log(`    reason:            ${c.white}${body.reason}${c.reset}`);
      console.log(`    email:             ${c.white}${body.email}${c.reset}`);
      console.log(`    retryAfterSeconds: ${c.white}${body.retryAfterSeconds}${c.reset}`);
      console.log("");
    }
  }

  // Missing service header (API key)
  console.log(`${c.yellow}▸ ListNotes (no API key) → ValidationError${c.reset}`);
  try {
    await client.listNotes({} as any, {
      apiKey: "",  // Override with empty to trigger missing header
      headers: { "X-API-Key": "" },
    });
  } catch (e) {
    if (e instanceof ValidationError) {
      console.log(`  ${c.red}✗ ValidationError${c.reset}: ${e.violations.map((v) => `${v.field}: ${v.description}`).join(", ")}`);
      console.log("");
    } else if (e instanceof ApiError) {
      try {
        const parsed = JSON.parse(e.body);
        if (parsed.violations) {
          console.log(`  ${c.red}✗ ValidationError (via ApiError ${e.statusCode})${c.reset}:`);
          for (const v of parsed.violations) {
            console.log(`    ${v.field}: ${v.description}`);
          }
          console.log("");
        }
      } catch {}
    }
  }

  // Type checking
  console.log(`${c.yellow}▸ Error type checking (instanceof)${c.reset}`);
  try {
    await client.getNote({ id: "nope" });
  } catch (e) {
    console.log(`  instanceof ApiError:        ${c.bold}${e instanceof ApiError}${c.reset}`);
    console.log(`  instanceof ValidationError: ${c.bold}${e instanceof ValidationError}${c.reset}`);
    console.log(`  instanceof Error:           ${c.bold}${e instanceof Error}${c.reset}`);
    console.log("");
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("");
  const client = createClient();
  await demoCrud(client);
  await demoQueries(client);
  await demoErrors(client);

  console.log(`${c.bold}═══════════════════════════════════════════════════════${c.reset}`);
  console.log(`${c.bold}  Demo complete${c.reset}`);
  console.log(`${c.bold}═══════════════════════════════════════════════════════${c.reset}`);
  console.log("");
}

main().catch(console.error);
