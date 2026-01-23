import { OAuth2Client, Credentials } from 'google-auth-library';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger.js';

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
  token_type?: string;
  scope?: string;
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

const DEFAULT_SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * Get the default token file path
 */
export function getDefaultTokenPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(homeDir, '.config', 'mcp-sheet-filler', 'tokens.json');
}

/**
 * Load tokens from file
 */
export function loadTokens(tokenPath?: string): OAuthTokens | null {
  const filePath = tokenPath || getDefaultTokenPath();

  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as OAuthTokens;
  } catch (error) {
    logger.error('load_tokens_failed', { path: filePath, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/**
 * Save tokens to file with secure permissions
 */
export function saveTokens(tokens: OAuthTokens, tokenPath?: string): void {
  const filePath = tokenPath || getDefaultTokenPath();

  // Create directory if it doesn't exist
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // Write tokens with 0600 permissions (owner read/write only)
  fs.writeFileSync(filePath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  logger.info('tokens_saved', { path: filePath });
}

/**
 * Check if token is expired (with 5 minute buffer)
 */
export function isTokenExpired(tokens: OAuthTokens): boolean {
  if (!tokens.expiry_date) {
    return false; // No expiry info, assume valid
  }
  // Add 5 minute buffer before expiry
  return Date.now() >= tokens.expiry_date - 5 * 60 * 1000;
}

/**
 * Create an OAuth2Client
 */
export function createOAuth2Client(clientId: string, clientSecret: string): OAuth2Client {
  return new OAuth2Client(clientId, clientSecret);
}

/**
 * Refresh access token using refresh token
 */
export async function refreshAccessToken(
  client: OAuth2Client,
  tokens: OAuthTokens
): Promise<OAuthTokens> {
  if (!tokens.refresh_token) {
    throw new Error('No refresh token available');
  }

  client.setCredentials(tokens as Credentials);

  const { credentials } = await client.refreshAccessToken();

  const newTokens: OAuthTokens = {
    access_token: credentials.access_token!,
    refresh_token: credentials.refresh_token || tokens.refresh_token,
    expiry_date: credentials.expiry_date || undefined,
    token_type: credentials.token_type || undefined,
    scope: credentials.scope || undefined,
  };

  logger.info('token_refreshed', { expiry_date: newTokens.expiry_date });

  return newTokens;
}

/**
 * Request a device code from Google OAuth
 */
export async function requestDeviceCode(clientId: string): Promise<DeviceCodeResponse> {
  const params = new URLSearchParams({
    client_id: clientId,
    scope: DEFAULT_SCOPES.join(' '),
  });

  const response = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    logger.error('device_code_request_failed', { status: response.status, error });
    throw new Error(`Failed to request device code: ${error}`);
  }

  const data = await response.json();
  logger.info('device_code_requested', { user_code: data.user_code, expires_in: data.expires_in });

  return {
    device_code: data.device_code,
    user_code: data.user_code,
    verification_url: data.verification_url,
    expires_in: data.expires_in,
    interval: data.interval || 5,
  };
}

/**
 * Poll Google's token endpoint for tokens after user completes device flow
 */
export async function pollForTokens(
  clientId: string,
  clientSecret: string,
  deviceCode: string,
  maxAttempts: number = 60,
  intervalMs: number = 5000
): Promise<OAuthTokens> {
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const data = await response.json();

    if (response.ok) {
      logger.info('device_code_tokens_received', { expiry_date: data.expires_in });
      return {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expiry_date: Date.now() + (data.expires_in * 1000),
        token_type: data.token_type,
        scope: data.scope,
      };
    }

    // Check for pending authorization
    if (data.error === 'authorization_pending') {
      // User hasn't completed authorization yet, wait and retry
      await new Promise(resolve => setTimeout(resolve, intervalMs));
      continue;
    }

    // Check for slow down request
    if (data.error === 'slow_down') {
      intervalMs += 5000; // Increase interval as requested
      await new Promise(resolve => setTimeout(resolve, intervalMs));
      continue;
    }

    // Check for expired code
    if (data.error === 'expired_token') {
      throw new Error('Device code expired. Please start authentication again.');
    }

    // Check for access denied
    if (data.error === 'access_denied') {
      throw new Error('Access denied. User declined authorization.');
    }

    // Other errors
    logger.error('device_code_poll_failed', { error: data.error, description: data.error_description });
    throw new Error(data.error_description || data.error || 'Failed to get tokens');
  }

  throw new Error('Polling timed out. Please try authentication again.');
}
