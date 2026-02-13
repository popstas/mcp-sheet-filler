# Antigravity Re-Login Investigation

## Problem

The Antigravity MCP client (a VS Code extension) gets logged out after approximately 1 hour when connected to the mcp-sheet-filler server via HTTP transport. The client log shows:

```
No refresh token available for scopes openid email https://www.googleapis.com/auth/spreadsheets. Throwing away token.
```

After this error, the user must manually re-authenticate.

## Server Configuration

- Docker deployment with `docker-compose`
- `AUTH_DB_PATH=/data/auth.db` (persistent SQLite storage, not in-memory)
- HTTP transport with OAuth authorization server
- Google OAuth with `access_type=offline` and `prompt=consent` (correctly configured)

## Investigation

### Code paths examined

1. **Authorization Server** (`src/auth/authorization-server.ts`):
   - Google consent URL correctly includes `access_type: 'offline'` and `prompt: 'consent'` (lines 136-144)
   - Refresh tokens are stored in SQLite via `SqliteMap` and issued to clients as opaque tokens (lines 299-308)
   - `refreshAccessToken()` correctly handles `grant_type=refresh_token` requests (lines 318-384)

2. **OAuth module** (`src/auth/oauth.ts`):
   - The "No refresh token available" error at lines 127-129 is from the device code flow path, not the authorization server path used by Antigravity

3. **HTTP transport** (`src/transport/http.ts`):
   - Session auth caching for SSE streams
   - `authenticateRequest()` validates tokens on each request

### Database evidence

The `auth.db` contained:
- 16 registered clients (Dynamic Client Registration)
- 14 refresh tokens
- 3 refresh tokens specifically for the Antigravity client (`338bc763`)

This confirms the server correctly issues and persists refresh tokens.

### Timeline for Antigravity client `338bc763`

| Time (UTC)    | Event                                          |
|---------------|-------------------------------------------------|
| Feb 12, 23:19 | Initial auth + tokens issued                   |
| Feb 13, 09:28 | `token_refreshed_via_google` - refresh worked   |
| Feb 13, 10:23 | Server restart                                  |
| Feb 13, 10:24 | Full re-auth (client didn't try refresh)        |
| Feb 13, 10:25 | New tokens exchanged                            |
| Feb 13, 14:47 | `token_refreshed_via_google` - refresh worked   |
| Feb 13, 14:56 | Server restart                                  |
| Feb 13, 14:59 | Client reconnected with still-valid token       |
| Feb 13, 16:13 | Server restart (token now expired by this time) |
| Feb 13, 16:13 | Client: "No refresh token available"            |
| Feb 13, 19:05 | Full re-auth by user                            |

### Key observations

1. **Refresh works when the client uses it**: At 09:28 and 14:47, the client successfully refreshed tokens via the server's `/auth/token` endpoint.

2. **Pattern after server restarts**: When the SSE connection drops (due to server restart) and the access token is still valid, the client reconnects fine (14:59). When the access token has expired, the client fails with "No refresh token available" instead of attempting a refresh (16:13).

3. **The server always has the refresh token**: The auth.db consistently contains valid refresh tokens for this client. The server-side refresh logic works correctly (proven by successful refreshes).

## Root Cause

The bug is in the **Antigravity client** (VS Code MCP extension), not the server.

The client loses its stored refresh token when the SSE connection drops. The specific failure mode:

1. SSE connection is established, client has both access token and refresh token
2. Server restarts (or SSE connection drops for any reason)
3. Client detects the disconnection
4. **Client discards or loses its refresh token** (bug)
5. If the access token is still valid, the client reconnects successfully using just the access token
6. If the access token has expired, the client has no refresh token to obtain a new one and reports "No refresh token available"

## Possible Server-Side Mitigations

While the root cause is client-side, the server could reduce the impact:

1. **Issue longer-lived access tokens** to survive more server restarts without requiring a refresh
2. **Proactive background refresh** of Google tokens server-side, so cached tokens remain valid longer
3. **Diagnostic logging** to track when refresh tokens are included/excluded from token responses, aiding future debugging
