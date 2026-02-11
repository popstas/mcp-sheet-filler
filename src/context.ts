import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  userId: string;
  email?: string;
  /** Access token from MCP auth - can be reused for Google Sheets API */
  accessToken?: string;
  /** MCP session ID (from Mcp-Session-Id header in HTTP transport) */
  sessionId?: string;
}

// Global context storage for request-scoped user identification
export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Get the current user ID from the request context.
 * Returns 'default' if no context is set (for local development or stdio transport).
 */
export function getCurrentUserId(): string {
  const store = requestContext.getStore();
  if (!store) {
    return 'default';
  }
  return store.userId;
}

/**
 * Get the current access token from the request context.
 * Returns undefined if no context is set or no token is available.
 */
export function getCurrentAccessToken(): string | undefined {
  const store = requestContext.getStore();
  return store?.accessToken;
}

/**
 * Get the current session ID from the request context (truncated to 8 chars).
 * Returns undefined if no context or no session ID is set.
 */
export function getCurrentSessionId(): string | undefined {
  const store = requestContext.getStore();
  const sid = store?.sessionId;
  return sid ? sid.slice(0, 8) : undefined;
}

/**
 * Validate user ID - only allow safe characters for filesystem paths.
 * Returns sanitized user ID.
 */
export function sanitizeUserId(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9-_@.]/g, '_').slice(0, 64);
}
