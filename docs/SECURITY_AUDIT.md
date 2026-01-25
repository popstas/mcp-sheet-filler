# Security Audit Report

**Date:** 2025-01-25  
**Scope:** mcp-sheet-filler codebase, dependencies, and deployment

---

## 1. Dependency Audit

### 1.1 Known Vulnerabilities

- **npm audit:** `0 vulnerabilities` reported.

### 1.2 Outdated Packages

| Package       | Current | Latest  |
|--------------|---------|---------|
| @types/node  | 25.0.9  | 25.0.10 |
| vitest       | 4.0.17  | 4.0.18  |
| zod          | 4.3.5   | 4.3.6   |

**Recommendation:** Run `npm update` to stay current. These are minor/patch bumps.

### 1.3 Third-Party Review

- **@modelcontextprotocol/sdk:** MCP protocol implementation; pulls in `express`, `express-rate-limit`. No known issues.
- **googleapis:** Official Google APIs client. Keep updated for API and security fixes.
- **zod:** Schema validation; no network/subsystem use.

---

## 2. Code Security Review

### 2.1 Secrets and Sensitive Data

| Check | Status |
|-------|--------|
| No hardcoded secrets | ✅ All credentials from `process.env` |
| .env in .gitignore | ✅ |
| .env in .dockerignore | ✅ |

### 2.2 Input Validation

- **Tool inputs:** All tools validate via Zod schemas in `src/tools/schemas.ts`.
- **Save values:** `validation.ts` checks types (`number`, `date`, `url`, `email`, `json`, `enum:...`), and `processSaveValues` only allows known fields.
- **Path/user ID:** `sanitizeUserId()` restricts to `[a-zA-Z0-9-_@.]` and 64 chars to avoid path traversal.
- **Sheet ID:** `extractSheetIdFromUrl()` allows only `[a-zA-Z0-9-_]` in the ID.

**Recommendation (low):** Consider `z.string().max(50000)` for `values` in `saveObjectNoOverwrite` to align with Google Sheets cell limits and cap memory use.

### 2.3 Authentication

- **HTTP /mcp:** Bearer token required. `validateGoogleToken()` checks:
  - Token via Google `tokeninfo`
  - `aud` matches `GOOGLE_OAUTH_CLIENT_ID`
  - User identity from `email`/`sub` or `userinfo` when needed
- **401:** Sent with `WWW-Authenticate` and `resource_metadata` (RFC 9728).
- **Stdio:** No auth (local/single-user by design).

**Improvement (applied):** Tool logging no longer includes `device_code`; it is redacted in `server.ts` via `redactArgsForLog()`. `sheets_client_from_mcp_token` debug log no longer includes a token-derived `cacheKey`.

### 2.4 Authorization

- **Per-user isolation:** `AsyncLocalStorage` plus `getCurrentUserId()`/`getCurrentAccessToken()` separate OAuth and MCP token usage per request.
- **Token files:** Stored under `~/.config/mcp-sheet-filler/clients/{sanitized_user_id}/tokens.json` with mode `0o600`; parent dirs `0o700`.

**Finding – Shared `spreadsheetId` in HTTP mode:**  
`filler_use_sheet_id` updates a **process-wide** `state.spreadsheetId` in the Sheets adapter. In HTTP multi-tenant mode, one user can change the target sheet for all users.  

**Recommendation:**  
- Short term: Document that `filler_use_sheet_id` is process-wide and should be used with care when multiple tenants share one instance.  
- Long term: Store `spreadsheetId` in request context (and in adapter) when in HTTP mode so each tenant has a separate logical sheet.

### 2.5 Data Handling

- **No-overwrite:** `save_object_no_overwrite` and `processSaveValues` respect non-empty existing values.
- **Emptyness:** `isEmpty()` treats `null`, `undefined`, and whitespace-only strings as empty; `0`, `false`, `"0"` as non-empty.
- **OAuth tokens:** Held in memory and on disk with restrictive permissions; not logged.

---

## 3. Infrastructure Security

### 3.1 Environment Variables

- **Sensitive:** `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_SERVICE_ACCOUNT_KEY`, `GOOGLE_OAUTH_CLIENT_ID` — must be set via env or secrets, never in code.
- **Config:** `RESOURCE_URL`, `GOOGLE_SHEET_ID`, `OBJECT_KEY_FIELD`, `SHEET_TAB_*`, `GOOGLE_OAUTH_TOKEN_PATH`, `DEBUG_LOG`, `PORT`, `HOST`, `TRANSPORT` — no secrets, but `DEBUG_LOG` can contain sensitive data if logging is extended.

### 3.2 HTTP Transport

- **Body size:** `express.json({ limit: '100kb' })` is set to mitigate large-body DoS.
- **Auth:** `/mcp` requires a valid Bearer token; `/health` and `/.well-known/oauth-protected-resource` are unauthenticated by design.
- **CORS:** Not configured; acceptable if only server-side or same-origin clients call the API.

**Recommendations (optional):**

- **Rate limiting:** Add `express-rate-limit` (or similar) on `/mcp` to limit auth failures and expensive operations. The MCP SDK already depends on it; it can be wired in `http.ts`.
- **Security headers:** Consider `helmet` if serving browser clients.

### 3.3 Token Validation

- **tokeninfo:** Token is sent as `?access_token=...` (GET). It is `encodeURIComponent`-encoded.  
  **Improvement (low):** Prefer POST with form/JSON if Google’s tokeninfo supports it, to avoid the token appearing in URL-based logs and caches.

### 3.4 Docker

- **User:** Container runs as non-root user `app` (uid 1001, group `app`). `chown -R app:app /app` so the app can read its files.
- **Secrets:** Expect credentials via env or mounts; ensure any mounted token/config dirs are writable by `app` when using `filler_google_auth` or `DEBUG_LOG` under `/app`.

---

## 4. Security Checklist

| Item | Status |
|------|--------|
| Dependencies updated and secure | ✅ npm audit 0; optional `npm update` for minor bumps |
| No hardcoded secrets | ✅ |
| Input validation | ✅ Zod + validation.ts + path/sheet ID checks |
| Authentication | ✅ Bearer + Google tokeninfo + audience check |
| Authorization | ✅ Per-user OAuth/context; ⚠️ `spreadsheetId` shared in HTTP mode |
| Sensitive args redacted in logs | ✅ `device_code`; token-derived `cacheKey` removed |
| Token file permissions | ✅ `0o600` files, `0o700` dirs |
| JSON body limit | ✅ 100kb |
| Docker non-root | ✅ User `app` |
| .env excluded from Git and Docker build | ✅ |

---

## 5. Fixes Applied in This Audit

1. **server.ts:** `redactArgsForLog()` to redact `device_code` (and easily extend to other keys) in `tool_call`, `tool_error`, and `tool_unexpected_error` logs.
2. **storage/sheets.ts:** Removed `cacheKey` (first 16 chars of token) from `sheets_client_from_mcp_token` debug log.
3. **transport/http.ts:** Explicit `express.json({ limit: '100kb' })`.
4. **Dockerfile:** Non-root user `app` (addgroup/adduser), `chown -R app:app /app`, `USER app`.

---

## 6. Recommended Follow-Ups

1. **Authorization:** Make `spreadsheetId` per-request in HTTP mode (context + adapter changes).
2. **Dependencies:** Run `npm update` and re-run `npm audit` after upgrades.
3. **Rate limiting:** Add rate limiting on `/mcp` for production.
4. **Tokeninfo:** Prefer POST for Google tokeninfo if supported, to avoid tokens in URLs.
5. **Values length:** Optionally cap `values` in `saveObjectNoOverwrite` to match Sheets limits.
