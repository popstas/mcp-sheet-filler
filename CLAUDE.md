# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP server that provides tools for storing and safely auto-filling tabular data. Supports two storage backends: Google Sheets and SQLite. The server prevents overwriting already-filled values.

## Development Commands

```bash
npm install          # Install dependencies
npm run build        # Build TypeScript
npm run dev          # Run in dev mode (tsx, stdio)
npm run dev:http     # Run in dev mode (tsx, HTTP)
npm start            # Start MCP server (stdio)
npm run start:http   # Start MCP server (HTTP)
npm run auth         # Run OAuth authentication flow
npm test             # Run tests in watch mode (vitest)
npm run test:run     # Run tests once
npm test -- src/path/to/test.ts  # Run single test file
```

## Transport Modes

The server supports two transport modes:

- **stdio** (default) - Standard input/output, for local MCP client integration
- **http** - Streamable HTTP transport for remote deployment

### HTTP Transport

Set `TRANSPORT=http` to enable HTTP mode. The server exposes:

| Method | Path | Description |
|--------|------|-------------|
| POST | `/mcp` | MCP JSON-RPC endpoint |
| GET | `/health` | Health check (returns `{"status":"ok"}`) |

Example:
```bash
TRANSPORT=http npm run dev
curl http://localhost:3000/health
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Docker

Build and run with Docker:

```bash
docker build -t mcp-sheet-filler .
docker run -p 3000:3000 -v filler-data:/data mcp-sheet-filler
```

Or use docker-compose:

```bash
docker-compose up -d
```

The default Docker configuration uses SQLite with data persisted in `/data/filler.db`.

## Architecture

### Storage Layer

Two interchangeable backends configured via `STORAGE_BACKEND` env var:
- `sheets` - Google Sheets backend
- `sqlite` - SQLite backend

Both implement the `StorageAdapter` interface:
- `listFields(names?: string[]): Field[]`
- `getFieldsByNames(names: string[]): Field[]`
- `addField(field: Field): void`
- `getObjectByName(name: string): Object | null`
- `addObjectByName(name: string): void`
- `saveObjectNoOverwrite(name: string, values: Record<string,string>): Record<string, SaveStatus>`

Validation logic (emptiness checks, type validation, no-overwrite) lives in the common layer, not in adapters.

### Data Model

**Fields sheet/table** - metadata about columns:
- `name` (required, unique), `description`, `auto` (boolean), `instructions`, `type`, `example`

**Data sheet/table** - objects as rows, fields as columns:
- Key field configured via `OBJECT_KEY_FIELD` (default: `name`)

### MCP Tools

1. `filler_get_fields_by_names` - get field metadata by names
2. `filler_add_field` - add a new field
3. `filler_list_fields` - list all or subset of fields
4. `filler_get_object` / `filler_get_object_by_name` - get object by key
5. `filler_add_object_by_name` - create object with just the key
6. `filler_save_object_no_overwrite` - save values without overwriting non-empty fields
7. `filler_get_missing_auto_fields` - get empty auto-fill fields for an object
8. `filler_get_next_missing_fields_object` - get first object with missing auto-fill fields
9. `filler_use_sheet_id` - switch to a different Google Sheet by ID or URL
10. `filler_google_auth` - authenticate via device code flow (status, start_auth, complete_auth)

### Type Validation

Supported types: `string`, `number`, `date` (ISO), `datetime` (ISO), `url`, `email`, `json`, `enum:val1|val2|val3`

### Error Codes

`backend_not_configured`, `field_already_exists`, `field_not_found`, `object_already_exists`, `object_not_found`, `invalid_argument`, `storage_error`

Save statuses: `saved`, `skipped_already_set`, `rejected_unknown_field`, `rejected_invalid_type`

## Environment Variables

Common:
- `STORAGE_BACKEND` = `sheets` | `sqlite`
- `OBJECT_KEY_FIELD` = key field name (default: `name`)
- `DEBUG_LOG` = path to debug log file (if set, logs all events and errors)
- `TRANSPORT` = `stdio` | `http` (default: `stdio`)
- `PORT` = HTTP server port (default: `3000`)
- `HOST` = HTTP bind address (default: `0.0.0.0`)

Sheets:
- `GOOGLE_SHEET_ID`, `SHEET_TAB_DATA` (default: `data`), `SHEET_TAB_FIELDS` (default: `fields`)
- `GOOGLE_SERVICE_ACCOUNT_KEY` = JSON string or path to service account key file

OAuth (alternative to service account):
- `GOOGLE_OAUTH_CLIENT_ID` = OAuth 2.0 client ID
- `GOOGLE_OAUTH_CLIENT_SECRET` = OAuth 2.0 client secret
- `GOOGLE_OAUTH_TOKEN_PATH` = token file path (default: `~/.config/mcp-sheet-filler/tokens.json`)

SQLite:
- `SQLITE_PATH` = path to DB file

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
├── auth/
│   ├── oauth.ts          # OAuth device code flow, token management
│   └── cli.ts            # CLI entry point for `npm run auth`
├── storage/
│   ├── adapter.ts        # StorageAdapter interface, config from env
│   ├── sqlite.ts         # SQLite adapter
│   └── sheets.ts         # Google Sheets adapter (supports OAuth and service account)
├── transport/
│   ├── stdio.ts          # Stdio transport starter
│   └── http.ts           # HTTP transport + Express server
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
1. **OAuth tokens** - if token file exists and `GOOGLE_OAUTH_CLIENT_ID`/`SECRET` are set
2. **Service account** - if `GOOGLE_SERVICE_ACCOUNT_KEY` is set
3. **Application Default Credentials** - fallback

OAuth device code flow (via MCP tool):
1. Call `filler_google_auth` with `action: "start_auth"`
2. Tool returns verification URL and user code
3. User visits URL on any device, enters code, approves access
4. Call `filler_google_auth` with `action: "complete_auth"` and `device_code` from step 1
5. Tokens saved to `~/.config/mcp-sheet-filler/tokens.json`
6. MCP server uses tokens automatically

Alternative CLI flow:
1. Run `npm run auth` to start the device code flow
2. Visit the displayed URL and enter the code
3. Tokens saved after authorization

OAuth tokens are automatically refreshed when expired.
