# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP server that provides tools for storing and safely auto-filling tabular data using Google Sheets as the storage backend. The server prevents overwriting already-filled values.

## Development Commands

```bash
npm install          # Install dependencies
npm run build        # Build TypeScript
npm run dev          # Run in dev mode (tsx, stdio)
npm run dev:http     # Run in dev mode (tsx, HTTP)
npm start            # Start MCP server (stdio)
npm run start:http   # Start MCP server (HTTP)
npm run auth         # Run OAuth authentication flow
npm run lint         # Run ESLint
npm test             # Run tests in watch mode (vitest)
npm run test:run     # Run tests once
npm test -- src/path/to/test.ts  # Run single test file
```

## Transport Modes

The server supports two transport modes:

- **stdio** (default) - Standard input/output, for local MCP client integration
- **http** - Streamable HTTP transport for remote deployment

### HTTP Transport

Set `TRANSPORT=http` to enable HTTP mode. HTTP transport requires OAuth authentication per the MCP Authorization specification (RFC 9728).

**Required environment variables for HTTP transport:**
- `RESOURCE_URL` - Public URL of this server
- `GOOGLE_OAUTH_CLIENT_ID` - Google OAuth client ID
- `GOOGLE_OAUTH_CLIENT_SECRET` - Google OAuth client secret

The server exposes:

| Method | Path | Description |
|--------|------|-------------|
| POST | `/mcp` | MCP JSON-RPC endpoint (requires auth) |
| GET | `/mcp` | SSE stream (requires auth) |
| DELETE | `/mcp` | Session teardown (requires auth) |
| GET | `/health` | Health check (no auth) |
| GET | `/.well-known/oauth-protected-resource` | RFC 9728 Protected Resource Metadata (no auth) |

**Authentication:** Requests to `/mcp` must include a valid Google OAuth access token in the `Authorization: Bearer <token>` header. The token must have been issued for the same OAuth client ID as configured on the server.

Example:
```bash
RESOURCE_URL=https://example.com TRANSPORT=http npm run dev
curl http://localhost:3000/health
curl http://localhost:3000/.well-known/oauth-protected-resource
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ya29.xxx" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

**401 Response:** Unauthorized requests receive a 401 with a `WWW-Authenticate` header pointing to the Protected Resource Metadata endpoint.

## Docker

Build and run with Docker:

```bash
docker build -t mcp-sheet-filler .
docker run -p 3000:3000 \
  -e RESOURCE_URL=https://your-server.com \
  -e GOOGLE_SHEET_ID=your-sheet-id \
  -e GOOGLE_OAUTH_CLIENT_ID=your-client-id \
  -e GOOGLE_OAUTH_CLIENT_SECRET=your-client-secret \
  mcp-sheet-filler
```

Or use docker-compose:

```bash
docker-compose up -d
```

## Architecture

### Storage Layer

Google Sheets backend configured via environment variables. Implements the `StorageAdapter` interface:
- `listFields(names?: string[]): Field[]`
- `getFieldsByNames(names: string[]): Field[]`
- `addField(field: Field): void`
- `getObjectByName(name: string): Object | null`
- `addObjectByName(name: string): void`
- `saveObjectNoOverwrite(name: string, values: Record<string,string>): Record<string, SaveStatus>`

Validation logic (emptiness checks, type validation, no-overwrite) lives in the common layer, not in adapters.

### Data Model

**Fields sheet** - metadata about columns:
- `name` (required, unique), `description`, `auto` (boolean), `instructions`, `type`, `example`

**Data sheet** - the first existing tab in the spreadsheet is used as the data source (objects as rows, fields as columns):
- Key field is the first column (configurable via `OBJECT_KEY_FIELD` for display, default: `name`)

### MCP Tools

1. `filler_init` - create fields tab and populate from first tab's column headers
2. `filler_add_fields` - add new fields (batch)
3. `filler_list_fields` - list all or subset of fields
4. `filler_get_objects_by_name` - get objects by names with missing auto fields (batch)
5. `filler_add_objects_by_name` - create objects with just the key (batch)
6. `filler_save_objects_no_overwrite` - save values for multiple objects at once without overwriting non-empty fields
7. `filler_get_next_missing_fields_objects` - get objects with missing auto-fill fields (default limit 1)
8. `filler_use_sheet_id` - switch to a different Google Sheet by ID or URL
9. `filler_google_auth` - authenticate via device code flow (status, start_auth, complete_auth)

### MCP Resources

- `filler://instructions` — static text resource with usage instructions (setup, workflow, available tools, field properties, save statuses)

### MCP Prompts

- `fill-sheet` — prompt template that guides the LLM through the sheet-filling workflow. Optional `object_name` argument: if provided, starts with `filler_get_object_by_name` for that object; if omitted, starts with `filler_get_next_missing_fields_objects` (default limit 1).

### Type Validation

Supported types: `string`, `number`, `date` (ISO), `datetime` (ISO), `url`, `email`, `json`, `enum:val1|val2|val3`

### Error Codes

`backend_not_configured`, `field_already_exists`, `field_not_found`, `object_already_exists`, `object_not_found`, `invalid_argument`, `storage_error`, `unauthorized`, `invalid_token`, `insufficient_scope`

Save statuses: `saved`, `skipped_already_set`, `rejected_unknown_field`, `rejected_invalid_type`

## Environment Variables

Common:
- `OBJECT_KEY_FIELD` = key field name (default: `name`)
- `DEBUG_LOG` = path to debug log file (if set, logs all events and errors)
- `TRANSPORT` = `stdio` | `http` (default: `stdio`)
- `PORT` = HTTP server port (default: `3000`)
- `HOST` = HTTP bind address (default: `0.0.0.0`)
- `RESOURCE_URL` = public URL of this server (required for HTTP transport)
- `AUTH_DB_PATH` = path to SQLite database for OAuth persistence (default: `:memory:`)

Google Sheets:
- `GOOGLE_SHEET_ID` - Google Sheets document ID
- `SHEET_TAB_DATA` - data tab name (default: first tab in the spreadsheet)
- `SHEET_TAB_FIELDS` - fields tab name (default: `fields`)
- `GOOGLE_SERVICE_ACCOUNT_KEY` = JSON string or path to service account key file

OAuth (alternative to service account):
- `GOOGLE_OAUTH_CLIENT_ID` = OAuth 2.0 client ID
- `GOOGLE_OAUTH_CLIENT_SECRET` = OAuth 2.0 client secret
- `GOOGLE_OAUTH_TOKEN_PATH` = token file path (default: `~/.config/mcp-sheet-filler/tokens.json`)

## Key Invariants

- Field names must be unique
- `save_object_no_overwrite` never changes non-empty values
- Empty value = null, empty string, or whitespace-only string; `0`, `false`, `"0"` are non-empty

## Project Structure

```
src/
├── index.ts              # Entry point, transport selection, CLI mode
├── server.ts             # Shared server creation (createAdapter, createServer)
├── types.ts              # Field, DataObject, SaveStatus, FillerError
├── validation.ts         # isEmpty, validateType, processSaveValues
├── logger.ts             # Debug logging (writes to DEBUG_LOG path if set)
├── context.ts            # Request context (AsyncLocalStorage for per-client isolation)
├── auth/
│   ├── cli.ts            # CLI entry point for `npm run auth`
│   ├── metadata.ts       # RFC 9728 Protected Resource Metadata generation
│   ├── oauth.ts          # OAuth device code flow, token management
│   ├── store.ts          # SqliteMap class + openAuthDb for OAuth persistence
│   ├── token-validator.ts # Google access token validation
│   └── types.ts          # Auth-related type definitions
├── storage/
│   ├── adapter.ts        # StorageAdapter interface, config from env
│   └── sheets.ts         # Google Sheets adapter (supports OAuth and service account)
├── transport/
│   ├── stdio.ts          # Stdio transport starter
│   └── http.ts           # HTTP transport + Express server (MCP auth compliant)
└── tools/
    ├── index.ts          # Tool handlers
    └── schemas.ts        # Zod schemas for input validation
```

## Implementation Notes

- Tool handlers are in `src/tools/index.ts`, tool registration with MCP server is in `src/server.ts`
- Zod schemas in `src/tools/schemas.ts` are used for runtime input validation
- All validation logic (type checking, emptiness, no-overwrite) is in `src/validation.ts`, adapters only do I/O
- Sheets adapter uses first column as object key (any column name works)

### Google Sheets Authentication

Auth priority (checked in order):
1. **MCP access token** - if request includes `Authorization: Bearer` header with Google token (HTTP transport)
2. **OAuth tokens** - if token file exists and `GOOGLE_OAUTH_CLIENT_ID`/`SECRET` are set
3. **Service account** - if `GOOGLE_SERVICE_ACCOUNT_KEY` is set
4. **Application Default Credentials** - fallback

#### Unified Auth (HTTP Transport - Recommended)

When using HTTP transport, the MCP access token is automatically reused for Google Sheets API access. This means:
- **No separate `filler_google_auth` needed** - one auth, two purposes
- Client authenticates once with Google (with `spreadsheets` scope)
- Same token authenticates to MCP server AND accesses Google Sheets

**Requirements:**
- Token must include `https://www.googleapis.com/auth/spreadsheets` scope
- Token must be issued for the same OAuth client ID as the server

#### Separate Auth Flow (Optional)

If the MCP token doesn't include Sheets scope, use `filler_google_auth`:

1. Call `filler_google_auth` with `action: "start_auth"`
2. Tool returns verification URL and user code
3. User visits URL on any device, enters code, approves access
4. Call `filler_google_auth` with `action: "complete_auth"` and `device_code` from step 1
5. Tokens saved to user-specific file (see Multi-Tenancy below)
6. MCP server uses tokens automatically

Alternative CLI flow:
1. Run `npm run auth` to start the device code flow
2. Visit the displayed URL and enter the code
3. Tokens saved after authorization

OAuth tokens are automatically refreshed when expired.

### Multi-Tenancy (Per-Client Auth Isolation)

The server supports per-client authentication isolation using `AsyncLocalStorage`. Each client has its own Google Sheets OAuth tokens stored separately.

**Client Identification:**

- **HTTP transport**: User ID extracted from validated Google OAuth access token (email or sub claim)
- **Stdio transport**: Uses `default` user (single-client mode)

**Authentication Flow (HTTP transport):**

1. Client obtains a Google OAuth access token (using the same OAuth client ID as the server)
2. Client sends requests to `/mcp` with `Authorization: Bearer <access_token>` header
3. Server validates the token with Google's tokeninfo endpoint
4. Server verifies the token's audience matches the configured client ID
5. User email from the token is used for per-user token storage

**Token Storage:**

- **HTTP transport:** Tokens are **not stored on the server**. Only MCP access token from Authorization header is used (ephemeral, per-request). This prevents server owner from accessing user tokens.
- **Stdio transport:** Tokens stored locally on user's machine:
```
~/.config/mcp-sheet-filler/
├── tokens.json                    # Legacy/default user tokens (stdio)
└── clients/
    └── {user_email}/
        └── tokens.json            # Per-client Google Sheets tokens
```

**Client Configuration Example:**

Claude Desktop (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "sheet-filler": {
      "url": "https://your-server.com/mcp",
      "headers": {
        "Authorization": "Bearer ya29.xxx..."
      }
    }
  }
}
```

**Security Notes:**

- All HTTP requests to `/mcp` require a valid Google OAuth access token
- Token audience must match the server's OAuth client ID
- User identity is cryptographically verified via Google
- **HTTP transport:** Tokens are not stored on the server (neither on disk nor in persistent memory cache). Only MCP access token from Authorization header is used, preventing server owner from accessing user tokens.
- **Stdio transport:** Each client's Google Sheets tokens stored in separate file with `0600` permissions (local storage only)
- Clients cannot access other clients' tokens through the API
