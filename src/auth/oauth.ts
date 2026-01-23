import { OAuth2Client, Credentials, CodeChallengeMethod } from 'google-auth-library';
import * as http from 'http';
import * as url from 'url';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { logger } from '../logger.js';

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
  token_type?: string;
  scope?: string;
}

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  scopes?: string[];
}

const DEFAULT_SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const REDIRECT_PORT = 3000;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/oauth2callback`;

/**
 * Get the default token file path
 */
export function getDefaultTokenPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(homeDir, '.config', 'mcp-sheet-filler', 'tokens.json');
}

/**
 * Generate PKCE code verifier and challenge
 */
function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  // Generate random 32 bytes and encode as base64url
  const codeVerifier = crypto.randomBytes(32)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  // Generate SHA256 hash and encode as base64url
  const codeChallenge = crypto.createHash('sha256')
    .update(codeVerifier)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  return { codeVerifier, codeChallenge };
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
 * Create an OAuth2Client with the given config
 */
export function createOAuth2Client(config: OAuthConfig): OAuth2Client {
  return new OAuth2Client(
    config.clientId,
    config.clientSecret,
    REDIRECT_URI
  );
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
 * Run the OAuth flow with loopback server
 */
export async function runOAuthFlow(config: OAuthConfig): Promise<OAuthTokens> {
  const client = createOAuth2Client(config);
  const scopes = config.scopes || DEFAULT_SCOPES;

  const { codeVerifier, codeChallenge } = generatePKCE();

  // Generate auth URL with PKCE
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: codeChallenge,
    prompt: 'consent', // Force consent to get refresh token
  });

  return new Promise((resolve, reject) => {
    // Create local server to receive callback
    const server = http.createServer(async (req, res) => {
      try {
        const parsedUrl = url.parse(req.url || '', true);

        if (parsedUrl.pathname !== '/oauth2callback') {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const code = parsedUrl.query.code as string;
        const error = parsedUrl.query.error as string;

        if (error) {
          res.writeHead(400);
          res.end(`Authentication failed: ${error}`);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (!code) {
          res.writeHead(400);
          res.end('No authorization code received');
          server.close();
          reject(new Error('No authorization code received'));
          return;
        }

        // Exchange code for tokens with PKCE verifier
        const { tokens } = await client.getToken({
          code,
          codeVerifier,
        });

        const oauthTokens: OAuthTokens = {
          access_token: tokens.access_token!,
          refresh_token: tokens.refresh_token || undefined,
          expiry_date: tokens.expiry_date || undefined,
          token_type: tokens.token_type || undefined,
          scope: tokens.scope || undefined,
        };

        // Send success response
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <body style="font-family: system-ui, sans-serif; padding: 40px; text-align: center;">
              <h1 style="color: #22c55e;">Authentication Successful!</h1>
              <p>You can close this window and return to the terminal.</p>
            </body>
          </html>
        `);

        server.close();
        resolve(oauthTokens);
      } catch (err) {
        res.writeHead(500);
        res.end('Internal server error');
        server.close();
        reject(err);
      }
    });

    // Bind to loopback only for security
    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      logger.info('oauth_server_started', { port: REDIRECT_PORT });
      console.log('\nOpening browser for Google authentication...');
      console.log(`\nIf the browser doesn't open automatically, visit:\n${authUrl}\n`);

      // Try to open browser
      openBrowser(authUrl).catch(() => {
        // Silent fail - user can manually open URL
      });
    });

    server.on('error', (err) => {
      reject(new Error(`Failed to start OAuth server: ${err.message}`));
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('OAuth flow timed out'));
    }, 5 * 60 * 1000);
  });
}

/**
 * Open URL in default browser
 */
async function openBrowser(url: string): Promise<void> {
  const { default: open } = await import('open');
  await open(url);
}
