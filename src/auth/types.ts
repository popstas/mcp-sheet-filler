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

/**
 * RFC 8414 Authorization Server Metadata
 */
export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  code_challenge_methods_supported: string[];
}

/**
 * Dynamic Client Registration request (RFC 7591)
 */
export interface DCRRequest {
  redirect_uris: string[];
  client_name?: string;
  token_endpoint_auth_method?: string;
}

/**
 * Dynamic Client Registration response
 */
export interface DCRResponse {
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
  client_name?: string;
  token_endpoint_auth_method: string;
}

/**
 * A registered OAuth client (stored in memory)
 */
export interface RegisteredClient {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  clientName?: string;
  createdAt: number;
}

/**
 * Pending Google authorization (between /auth redirect and /auth/callback)
 */
export interface PendingGoogleAuth {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  clientState: string;
  createdAt: number;
}

/**
 * Pending authorization code (between /auth/callback and /auth/token)
 */
export interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  googleAccessToken: string;
  googleRefreshToken?: string;
  googleExpiresIn?: number;
  createdAt: number;
}

/**
 * Stored refresh token mapping (our opaque token → Google refresh token)
 */
export interface StoredRefreshToken {
  clientId: string;
  googleRefreshToken: string;
  createdAt: number;
}
