# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP server that provides tools for storing and safely auto-filling tabular data. Supports two storage backends: Google Sheets and SQLite. The server prevents overwriting already-filled values.

## Development Commands

```bash
npm install          # Install dependencies
npm run build        # Build TypeScript
npm run dev          # Run in dev mode (tsx)
npm start            # Start MCP server (built)
npm run auth         # Run OAuth authentication flow
npm test             # Run tests in watch mode (vitest)
npm run test:run     # Run tests once
npm test -- src/path/to/test.ts  # Run single test file
```

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
10. `filler_google_auth` - check auth status or set OAuth tokens at runtime

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
├── index.ts              # MCP server entry point, tool registration, CLI mode
├── types.ts              # Field, DataObject, SaveStatus, FillerError
├── validation.ts         # isEmpty, validateType, processSaveValues
├── logger.ts             # Debug logging (writes to DEBUG_LOG path if set)
├── auth/
│   ├── oauth.ts          # OAuth flow implementation (PKCE, token management)
│   └── cli.ts            # CLI entry point for `npm run auth`
├── storage/
│   ├── adapter.ts        # StorageAdapter interface, config from env
│   ├── sqlite.ts         # SQLite adapter
│   └── sheets.ts         # Google Sheets adapter (supports OAuth and service account)
└── tools/
    ├── index.ts          # Tool handlers
    └── schemas.ts        # Zod schemas for input validation
```

## Implementation Notes

- Tool handlers are in `src/tools/index.ts`, JSON schemas for MCP are defined inline in `src/index.ts`
- Zod schemas in `src/tools/schemas.ts` are used for runtime input validation
- All validation logic (type checking, emptiness, no-overwrite) is in `src/validation.ts`, adapters only do I/O
- Sheets adapter uses first column as object key (any column name works)

### Google Sheets Authentication

Auth priority (checked in order):
1. **OAuth tokens** - if token file exists and `GOOGLE_OAUTH_CLIENT_ID`/`SECRET` are set
2. **Service account** - if `GOOGLE_SERVICE_ACCOUNT_KEY` is set
3. **Application Default Credentials** - fallback

OAuth flow:
1. Run `npm run auth` to start the OAuth flow
2. Browser opens for Google consent
3. Local server on 127.0.0.1:3000 captures redirect
4. Tokens saved to `~/.config/mcp-sheet-filler/tokens.json`
5. MCP server uses tokens automatically on startup

OAuth tokens are automatically refreshed when expired. Uses PKCE (S256) for security.
