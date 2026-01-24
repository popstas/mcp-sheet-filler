/**
 * RFC 9728 Protected Resource Metadata
 * @see https://datatracker.ietf.org/doc/html/rfc9728
 */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
  bearer_methods_supported?: string[];
}

/**
 * Configuration for MCP authorization
 */
export interface AuthConfig {
  /** Public URL of this server (required for HTTP transport) */
  resourceUrl: string;
  /** Google OAuth client ID (for audience validation) */
  clientId: string;
  /** Google OAuth client secret */
  clientSecret: string;
}

/**
 * Result of token validation
 */
export interface TokenValidationResult {
  valid: boolean;
  /** User identifier (Google email) */
  userId?: string;
  /** User email address */
  email?: string;
  /** Error message if validation failed */
  error?: string;
}
