import crypto from 'node:crypto';
import { logger } from '../logger.js';
import type {
  AuthConfig,
  AuthorizationServerMetadata,
  DCRRequest,
  DCRResponse,
  RegisteredClient,
  PendingGoogleAuth,
  PendingAuthorization,
  StoredRefreshToken,
} from './types.js';
import { openAuthDb, SqliteMap } from './store.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/spreadsheets',
];

const AUTH_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const PENDING_AUTH_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Persistent stores (SQLite-backed, configurable via AUTH_DB_PATH)
const authDb = openAuthDb(process.env.AUTH_DB_PATH || ':memory:');
export const registeredClients = new SqliteMap<RegisteredClient>(authDb, 'registered_clients');
export const refreshTokens = new SqliteMap<StoredRefreshToken>(authDb, 'refresh_tokens');

// Pending auth stores (SQLite-backed for blue-green deployment, single-use with 10-min TTL)
export const pendingGoogleAuths = new SqliteMap<PendingGoogleAuth>(authDb, 'pending_google_auths');
export const pendingAuthorizations = new SqliteMap<PendingAuthorization>(authDb, 'pending_authorizations');

/**
 * Generate RFC 8414 Authorization Server Metadata.
 */
export function generateAuthServerMetadata(resourceUrl: string): AuthorizationServerMetadata {
  const baseUrl = resourceUrl.replace(/\/+$/, '');
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/auth`,
    token_endpoint: `${baseUrl}/auth/token`,
    registration_endpoint: `${baseUrl}/auth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['client_secret_post'],
    code_challenge_methods_supported: ['S256'],
  };
}

/**
 * Register a new OAuth client (Dynamic Client Registration).
 */
export function registerClient(request: DCRRequest): DCRResponse {
  if (!request.redirect_uris || request.redirect_uris.length === 0) {
    throw new Error('redirect_uris is required');
  }

  const clientId = crypto.randomUUID();
  const clientSecret = crypto.randomBytes(32).toString('hex');

  const client: RegisteredClient = {
    clientId,
    clientSecret,
    redirectUris: request.redirect_uris,
    clientName: request.client_name,
    createdAt: Date.now(),
  };

  registeredClients.set(clientId, client);
  logger.info('client_registered', { clientId, redirectUris: request.redirect_uris });

  return {
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uris: request.redirect_uris,
    client_name: request.client_name,
    token_endpoint_auth_method: 'client_secret_post',
  };
}

/**
 * Verify PKCE S256 code challenge.
 */
export function verifyCodeChallenge(codeVerifier: string, codeChallenge: string): boolean {
  const hash = crypto.createHash('sha256').update(codeVerifier).digest();
  return hash.toString('base64url') === codeChallenge;
}

/**
 * Create a pending Google auth and return the Google consent URL.
 */
export function createPendingGoogleAuth(
  params: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    state: string;
  },
  authConfig: AuthConfig
): { googleAuthUrl: string; stateParam: string } {
  // Validate client
  const client = registeredClients.get(params.clientId);
  if (!client) {
    throw new Error('Unknown client_id');
  }

  // Validate redirect_uri matches registration
  if (!client.redirectUris.includes(params.redirectUri)) {
    throw new Error('redirect_uri does not match registration');
  }

  // Only support S256
  if (params.codeChallengeMethod !== 'S256') {
    throw new Error('Only S256 code_challenge_method is supported');
  }

  // Generate our own state to link Google callback back to this request
  const ourState = crypto.randomBytes(32).toString('hex');

  const pending: PendingGoogleAuth = {
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: params.codeChallengeMethod,
    clientState: params.state,
    createdAt: Date.now(),
  };

  pendingGoogleAuths.set(ourState, pending);

  // Build Google consent URL
  const callbackUrl = `${authConfig.resourceUrl.replace(/\/+$/, '')}/auth/callback`;
  const googleParams = new URLSearchParams({
    client_id: authConfig.clientId,
    redirect_uri: callbackUrl,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    state: ourState,
    access_type: 'offline',
    prompt: 'consent',
  });

  const googleAuthUrl = `${GOOGLE_AUTH_URL}?${googleParams.toString()}`;

  logger.debug('pending_google_auth_created', { ourState, clientId: params.clientId });

  return { googleAuthUrl, stateParam: ourState };
}

/**
 * Handle Google OAuth callback: exchange Google code for tokens,
 * generate our own auth code, and return the redirect URL to the client.
 */
export async function handleGoogleCallback(
  state: string,
  googleCode: string,
  authConfig: AuthConfig
): Promise<{ redirectUrl: string }> {
  const pending = pendingGoogleAuths.get(state);
  if (!pending) {
    throw new Error('Invalid or expired state parameter');
  }

  // Remove pending auth (single-use)
  pendingGoogleAuths.delete(state);

  // Check expiry
  if (Date.now() - pending.createdAt > PENDING_AUTH_TTL_MS) {
    throw new Error('Authorization request expired');
  }

  // Exchange Google code for tokens
  const callbackUrl = `${authConfig.resourceUrl.replace(/\/+$/, '')}/auth/callback`;
  const tokenParams = new URLSearchParams({
    code: googleCode,
    client_id: authConfig.clientId,
    client_secret: authConfig.clientSecret,
    redirect_uri: callbackUrl,
    grant_type: 'authorization_code',
  });

  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenParams.toString(),
  });

  if (!tokenResponse.ok) {
    const errorData = await tokenResponse.text();
    logger.error('google_token_exchange_failed', { status: tokenResponse.status, error: errorData });
    throw new Error('Failed to exchange Google authorization code');
  }

  const googleTokens = (await tokenResponse.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
  };

  // Generate our own authorization code
  const ourCode = crypto.randomBytes(32).toString('hex');

  const authorization: PendingAuthorization = {
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    codeChallenge: pending.codeChallenge,
    googleAccessToken: googleTokens.access_token,
    googleRefreshToken: googleTokens.refresh_token,
    googleExpiresIn: googleTokens.expires_in,
    createdAt: Date.now(),
  };

  pendingAuthorizations.set(ourCode, authorization);

  // Build redirect URL back to the client
  const redirectUrl = new URL(pending.redirectUri);
  redirectUrl.searchParams.set('code', ourCode);
  redirectUrl.searchParams.set('state', pending.clientState);

  logger.debug('google_callback_handled', { clientId: pending.clientId });

  return { redirectUrl: redirectUrl.toString() };
}

/**
 * Exchange our authorization code for tokens (returns Google access token).
 */
export function exchangeCodeForTokens(
  params: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    codeVerifier: string;
  }
): {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope: string;
} {
  const pending = pendingAuthorizations.get(params.code);
  if (!pending) {
    throw new Error('Invalid or expired authorization code');
  }

  // Remove code (single-use)
  pendingAuthorizations.delete(params.code);

  // Check expiry
  if (Date.now() - pending.createdAt > AUTH_CODE_TTL_MS) {
    throw new Error('Authorization code expired');
  }

  // Validate client
  const client = registeredClients.get(params.clientId);
  if (!client) {
    throw new Error('Unknown client_id');
  }

  if (client.clientSecret !== params.clientSecret) {
    throw new Error('Invalid client_secret');
  }

  // Validate that the code was issued to this client
  if (pending.clientId !== params.clientId) {
    throw new Error('Authorization code was not issued to this client');
  }

  // Validate redirect_uri matches
  if (pending.redirectUri !== params.redirectUri) {
    throw new Error('redirect_uri does not match');
  }

  // Verify PKCE
  if (!verifyCodeChallenge(params.codeVerifier, pending.codeChallenge)) {
    throw new Error('Invalid code_verifier');
  }

  // Build response with Google access token
  const response: {
    access_token: string;
    token_type: string;
    expires_in?: number;
    refresh_token?: string;
    scope: string;
  } = {
    access_token: pending.googleAccessToken,
    token_type: 'Bearer',
    expires_in: pending.googleExpiresIn,
    scope: GOOGLE_SCOPES.join(' '),
  };

  // If Google provided a refresh token, store it and return our own opaque refresh token
  if (pending.googleRefreshToken) {
    const ourRefreshToken = crypto.randomBytes(32).toString('hex');
    refreshTokens.set(ourRefreshToken, {
      clientId: params.clientId,
      googleRefreshToken: pending.googleRefreshToken,
      createdAt: Date.now(),
    });
    response.refresh_token = ourRefreshToken;
  }

  logger.debug('code_exchanged_for_tokens', { clientId: params.clientId });

  return response;
}

/**
 * Refresh an access token using our opaque refresh token.
 */
export async function refreshAccessToken(
  params: {
    refreshToken: string;
    clientId: string;
    clientSecret: string;
  },
  authConfig: AuthConfig
): Promise<{
  access_token: string;
  token_type: string;
  expires_in?: number;
  scope: string;
}> {
  const stored = refreshTokens.get(params.refreshToken);
  if (!stored) {
    throw new Error('Invalid refresh_token');
  }

  // Validate client
  const client = registeredClients.get(params.clientId);
  if (!client) {
    throw new Error('Unknown client_id');
  }

  if (client.clientSecret !== params.clientSecret) {
    throw new Error('Invalid client_secret');
  }

  // Validate that the refresh token was issued to this client
  if (stored.clientId !== params.clientId) {
    throw new Error('Refresh token was not issued to this client');
  }

  // Refresh via Google
  const tokenParams = new URLSearchParams({
    client_id: authConfig.clientId,
    client_secret: authConfig.clientSecret,
    refresh_token: stored.googleRefreshToken,
    grant_type: 'refresh_token',
  });

  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenParams.toString(),
  });

  if (!tokenResponse.ok) {
    const errorData = await tokenResponse.text();
    logger.error('google_token_refresh_failed', { status: tokenResponse.status, error: errorData });
    throw new Error('Failed to refresh token with Google');
  }

  const googleTokens = (await tokenResponse.json()) as {
    access_token: string;
    expires_in?: number;
  };

  logger.debug('token_refreshed_via_google', { clientId: params.clientId });

  return {
    access_token: googleTokens.access_token,
    token_type: 'Bearer',
    expires_in: googleTokens.expires_in,
    scope: GOOGLE_SCOPES.join(' '),
  };
}

/**
 * Remove expired entries from all in-memory stores.
 */
export function cleanupExpired(): void {
  const now = Date.now();
  let cleaned = 0;

  for (const [key, value] of pendingGoogleAuths.entries()) {
    if (now - value.createdAt > PENDING_AUTH_TTL_MS) {
      pendingGoogleAuths.delete(key);
      cleaned++;
    }
  }

  for (const [key, value] of pendingAuthorizations.entries()) {
    if (now - value.createdAt > AUTH_CODE_TTL_MS) {
      pendingAuthorizations.delete(key);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    logger.debug('authorization_server_cleanup', { entriesRemoved: cleaned });
  }
}
