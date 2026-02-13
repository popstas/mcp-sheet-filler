import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import {
  generateAuthServerMetadata,
  registerClient,
  verifyCodeChallenge,
  createPendingGoogleAuth,
  handleGoogleCallback,
  exchangeCodeForTokens,
  refreshAccessToken,
  cleanupExpired,
  registeredClients,
  pendingGoogleAuths,
  pendingAuthorizations,
  refreshTokens,
} from '../auth/authorization-server.js';
import type { AuthConfig } from '../auth/types.js';

const mockAuthConfig: AuthConfig = {
  resourceUrl: 'https://example.com',
  clientId: 'google-client-id',
  clientSecret: 'google-client-secret',
};

/**
 * Helper: register a client and return its credentials.
 */
function registerTestClient(redirectUri = 'https://app.example.com/callback') {
  const dcr = registerClient({ redirect_uris: [redirectUri] });
  return { clientId: dcr.client_id, clientSecret: dcr.client_secret, redirectUri };
}

/**
 * Helper: generate a PKCE code_verifier and code_challenge (S256).
 */
function generatePkce() {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

describe('Authorization Server', () => {
  beforeEach(() => {
    // Clear all in-memory stores before each test
    registeredClients.clear();
    pendingGoogleAuths.clear();
    pendingAuthorizations.clear();
    refreshTokens.clear();
  });

  describe('generateAuthServerMetadata', () => {
    it('returns correct metadata structure', () => {
      const metadata = generateAuthServerMetadata('https://example.com');

      expect(metadata.issuer).toBe('https://example.com');
      expect(metadata.authorization_endpoint).toBe('https://example.com/auth');
      expect(metadata.token_endpoint).toBe('https://example.com/auth/token');
      expect(metadata.registration_endpoint).toBe('https://example.com/auth/register');
      expect(metadata.response_types_supported).toEqual(['code']);
      expect(metadata.grant_types_supported).toContain('authorization_code');
      expect(metadata.grant_types_supported).toContain('refresh_token');
      expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
    });

    it('strips trailing slashes from resourceUrl', () => {
      const metadata = generateAuthServerMetadata('https://example.com/');
      expect(metadata.issuer).toBe('https://example.com');
      expect(metadata.authorization_endpoint).toBe('https://example.com/auth');
    });
  });

  describe('registerClient (DCR)', () => {
    it('registers a client and returns credentials', () => {
      const response = registerClient({
        redirect_uris: ['https://app.example.com/callback'],
        client_name: 'Test App',
      });

      expect(response.client_id).toBeTruthy();
      expect(response.client_secret).toBeTruthy();
      expect(response.redirect_uris).toEqual(['https://app.example.com/callback']);
      expect(response.client_name).toBe('Test App');
      expect(response.token_endpoint_auth_method).toBe('client_secret_post');
    });

    it('stores the registered client in memory', () => {
      const response = registerClient({
        redirect_uris: ['https://app.example.com/callback'],
      });

      const stored = registeredClients.get(response.client_id);
      expect(stored).toBeTruthy();
      expect(stored!.clientId).toBe(response.client_id);
      expect(stored!.clientSecret).toBe(response.client_secret);
    });

    it('throws when redirect_uris is empty', () => {
      expect(() => registerClient({ redirect_uris: [] })).toThrow('redirect_uris is required');
    });

    it('throws when redirect_uris is missing', () => {

      expect(() => registerClient({} as any)).toThrow('redirect_uris is required');
    });

    it('generates unique client_ids', () => {
      const r1 = registerClient({ redirect_uris: ['https://a.example.com/cb'] });
      const r2 = registerClient({ redirect_uris: ['https://b.example.com/cb'] });
      expect(r1.client_id).not.toBe(r2.client_id);
    });
  });

  describe('verifyCodeChallenge (PKCE)', () => {
    it('returns true for correct code_verifier', () => {
      const { codeVerifier, codeChallenge } = generatePkce();
      expect(verifyCodeChallenge(codeVerifier, codeChallenge)).toBe(true);
    });

    it('returns false for incorrect code_verifier', () => {
      const { codeChallenge } = generatePkce();
      expect(verifyCodeChallenge('wrong-verifier', codeChallenge)).toBe(false);
    });

    it('returns false for empty verifier', () => {
      const { codeChallenge } = generatePkce();
      expect(verifyCodeChallenge('', codeChallenge)).toBe(false);
    });
  });

  describe('createPendingGoogleAuth', () => {
    it('creates a pending auth and returns Google URL', () => {
      const { clientId, redirectUri } = registerTestClient();
      const { codeChallenge } = generatePkce();

      const { googleAuthUrl, stateParam } = createPendingGoogleAuth(
        {
          clientId,
          redirectUri,
          codeChallenge,
          codeChallengeMethod: 'S256',
          state: 'client-state-123',
        },
        mockAuthConfig
      );

      expect(googleAuthUrl).toContain('accounts.google.com');
      expect(googleAuthUrl).toContain('client_id=google-client-id');
      expect(googleAuthUrl).toContain('redirect_uri=');
      expect(googleAuthUrl).toContain(encodeURIComponent('https://example.com/auth/callback'));
      expect(googleAuthUrl).toContain('response_type=code');
      expect(googleAuthUrl).toContain('access_type=offline');
      expect(stateParam).toBeTruthy();

      // Verify stored pending auth
      const pending = pendingGoogleAuths.get(stateParam);
      expect(pending).toBeTruthy();
      expect(pending!.clientId).toBe(clientId);
      expect(pending!.clientState).toBe('client-state-123');
    });

    it('rejects unknown client_id', () => {
      const { codeChallenge } = generatePkce();

      expect(() =>
        createPendingGoogleAuth(
          {
            clientId: 'unknown-client',
            redirectUri: 'https://app.example.com/callback',
            codeChallenge,
            codeChallengeMethod: 'S256',
            state: 'state',
          },
          mockAuthConfig
        )
      ).toThrow('Unknown client_id');
    });

    it('rejects mismatched redirect_uri', () => {
      const { clientId } = registerTestClient('https://app.example.com/callback');
      const { codeChallenge } = generatePkce();

      expect(() =>
        createPendingGoogleAuth(
          {
            clientId,
            redirectUri: 'https://evil.example.com/callback',
            codeChallenge,
            codeChallengeMethod: 'S256',
            state: 'state',
          },
          mockAuthConfig
        )
      ).toThrow('redirect_uri does not match registration');
    });

    it('rejects non-S256 code_challenge_method', () => {
      const { clientId, redirectUri } = registerTestClient();

      expect(() =>
        createPendingGoogleAuth(
          {
            clientId,
            redirectUri,
            codeChallenge: 'plain-challenge',
            codeChallengeMethod: 'plain',
            state: 'state',
          },
          mockAuthConfig
        )
      ).toThrow('Only S256 code_challenge_method is supported');
    });
  });

  describe('handleGoogleCallback', () => {
    beforeEach(() => {
      // Mock global fetch for Google token exchange
      vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('exchanges Google code and returns redirect URL', async () => {
      const { clientId, redirectUri } = registerTestClient();
      const { codeChallenge } = generatePkce();

      const { stateParam } = createPendingGoogleAuth(
        {
          clientId,
          redirectUri,
          codeChallenge,
          codeChallengeMethod: 'S256',
          state: 'client-state-abc',
        },
        mockAuthConfig
      );

      // Mock Google token response

      (fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'google-access-token-123',
          refresh_token: 'google-refresh-token-456',
          expires_in: 3600,
        }),
      });

      const { redirectUrl } = await handleGoogleCallback(stateParam, 'google-auth-code', mockAuthConfig);

      expect(redirectUrl).toContain(redirectUri);
      expect(redirectUrl).toContain('code=');
      expect(redirectUrl).toContain('state=client-state-abc');

      // Pending Google auth should be consumed (single-use)
      expect(pendingGoogleAuths.has(stateParam)).toBe(false);

      // A pending authorization should have been created
      expect(pendingAuthorizations.size).toBe(1);
    });

    it('throws for invalid state', async () => {
      await expect(
        handleGoogleCallback('invalid-state', 'code', mockAuthConfig)
      ).rejects.toThrow('Invalid or expired state parameter');
    });

    it('throws when Google token exchange fails', async () => {
      const { clientId, redirectUri } = registerTestClient();
      const { codeChallenge } = generatePkce();

      const { stateParam } = createPendingGoogleAuth(
        {
          clientId,
          redirectUri,
          codeChallenge,
          codeChallengeMethod: 'S256',
          state: 'state',
        },
        mockAuthConfig
      );


      (fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'invalid_grant',
      });

      await expect(
        handleGoogleCallback(stateParam, 'bad-code', mockAuthConfig)
      ).rejects.toThrow('Failed to exchange Google authorization code');
    });
  });

  describe('exchangeCodeForTokens', () => {
    it('returns Google access token on valid exchange', async () => {
      // Set up: register client, create pending auth, simulate Google callback
      const { clientId, clientSecret, redirectUri } = registerTestClient();
      const { codeVerifier, codeChallenge } = generatePkce();

      const { stateParam: _stateParam } = createPendingGoogleAuth(
        {
          clientId,
          redirectUri,
          codeChallenge,
          codeChallengeMethod: 'S256',
          state: 'client-state',
        },
        mockAuthConfig
      );

      // Manually create a pending authorization (simulating handleGoogleCallback)
      const ourCode = crypto.randomBytes(32).toString('hex');
      pendingAuthorizations.set(ourCode, {
        clientId,
        redirectUri,
        codeChallenge,
        googleAccessToken: 'google-at-xyz',
        googleRefreshToken: 'google-rt-xyz',
        googleExpiresIn: 3600,
        createdAt: Date.now(),
      });

      const tokens = exchangeCodeForTokens({
        code: ourCode,
        clientId,
        clientSecret,
        redirectUri,
        codeVerifier,
      });

      expect(tokens.access_token).toBe('google-at-xyz');
      expect(tokens.token_type).toBe('Bearer');
      expect(tokens.expires_in).toBe(3600);
      expect(tokens.refresh_token).toBeTruthy();
      expect(tokens.scope).toBe('openid email https://www.googleapis.com/auth/spreadsheets');

      // Code should be consumed (single-use)
      expect(pendingAuthorizations.has(ourCode)).toBe(false);

      // Refresh token should be stored
      expect(refreshTokens.has(tokens.refresh_token!)).toBe(true);
    });

    it('rejects invalid authorization code', () => {
      expect(() =>
        exchangeCodeForTokens({
          code: 'invalid-code',
          clientId: 'any',
          clientSecret: 'any',
          redirectUri: 'https://app.example.com/callback',
          codeVerifier: 'any',
        })
      ).toThrow('Invalid or expired authorization code');
    });

    it('rejects expired authorization code', () => {
      const { clientId, clientSecret, redirectUri } = registerTestClient();
      const { codeVerifier, codeChallenge } = generatePkce();

      const ourCode = 'expired-code';
      pendingAuthorizations.set(ourCode, {
        clientId,
        redirectUri,
        codeChallenge,
        googleAccessToken: 'token',
        createdAt: Date.now() - 11 * 60 * 1000, // 11 minutes ago (> 10 min TTL)
      });

      expect(() =>
        exchangeCodeForTokens({
          code: ourCode,
          clientId,
          clientSecret,
          redirectUri,
          codeVerifier,
        })
      ).toThrow('Authorization code expired');
    });

    it('rejects wrong client_id', () => {
      const { clientId, clientSecret: _clientSecret, redirectUri } = registerTestClient();
      const { codeVerifier, codeChallenge } = generatePkce();

      // Register a second client
      const other = registerTestClient('https://other.example.com/cb');

      const ourCode = 'code-for-client1';
      pendingAuthorizations.set(ourCode, {
        clientId, // issued to first client
        redirectUri,
        codeChallenge,
        googleAccessToken: 'token',
        createdAt: Date.now(),
      });

      expect(() =>
        exchangeCodeForTokens({
          code: ourCode,
          clientId: other.clientId, // but second client tries to use it
          clientSecret: other.clientSecret,
          redirectUri,
          codeVerifier,
        })
      ).toThrow('Authorization code was not issued to this client');
    });

    it('rejects invalid client_secret', () => {
      const { clientId, redirectUri } = registerTestClient();
      const { codeVerifier, codeChallenge } = generatePkce();

      const ourCode = 'code-123';
      pendingAuthorizations.set(ourCode, {
        clientId,
        redirectUri,
        codeChallenge,
        googleAccessToken: 'token',
        createdAt: Date.now(),
      });

      expect(() =>
        exchangeCodeForTokens({
          code: ourCode,
          clientId,
          clientSecret: 'wrong-secret',
          redirectUri,
          codeVerifier,
        })
      ).toThrow('Invalid client_secret');
    });

    it('rejects invalid code_verifier (PKCE)', () => {
      const { clientId, clientSecret, redirectUri } = registerTestClient();
      const { codeChallenge } = generatePkce();

      const ourCode = 'code-pkce-test';
      pendingAuthorizations.set(ourCode, {
        clientId,
        redirectUri,
        codeChallenge,
        googleAccessToken: 'token',
        createdAt: Date.now(),
      });

      expect(() =>
        exchangeCodeForTokens({
          code: ourCode,
          clientId,
          clientSecret,
          redirectUri,
          codeVerifier: 'wrong-verifier',
        })
      ).toThrow('Invalid code_verifier');
    });

    it('rejects mismatched redirect_uri', () => {
      const { clientId, clientSecret, redirectUri } = registerTestClient();
      const { codeVerifier, codeChallenge } = generatePkce();

      const ourCode = 'code-redirect-test';
      pendingAuthorizations.set(ourCode, {
        clientId,
        redirectUri,
        codeChallenge,
        googleAccessToken: 'token',
        createdAt: Date.now(),
      });

      expect(() =>
        exchangeCodeForTokens({
          code: ourCode,
          clientId,
          clientSecret,
          redirectUri: 'https://different.example.com/cb',
          codeVerifier,
        })
      ).toThrow('redirect_uri does not match');
    });

    it('enforces single-use: second exchange with same code fails', () => {
      const { clientId, clientSecret, redirectUri } = registerTestClient();
      const { codeVerifier, codeChallenge } = generatePkce();

      const ourCode = 'single-use-code';
      pendingAuthorizations.set(ourCode, {
        clientId,
        redirectUri,
        codeChallenge,
        googleAccessToken: 'token',
        googleRefreshToken: 'refresh',
        googleExpiresIn: 3600,
        createdAt: Date.now(),
      });

      // First exchange succeeds
      const tokens = exchangeCodeForTokens({
        code: ourCode,
        clientId,
        clientSecret,
        redirectUri,
        codeVerifier,
      });
      expect(tokens.access_token).toBe('token');

      // Second exchange fails
      expect(() =>
        exchangeCodeForTokens({
          code: ourCode,
          clientId,
          clientSecret,
          redirectUri,
          codeVerifier,
        })
      ).toThrow('Invalid or expired authorization code');
    });
  });

  describe('refreshAccessToken', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('refreshes token via Google', async () => {
      const { clientId, clientSecret } = registerTestClient();

      const ourRefreshToken = 'our-refresh-token-123';
      refreshTokens.set(ourRefreshToken, {
        clientId,
        googleRefreshToken: 'google-refresh-token',
        createdAt: Date.now(),
      });

      (fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'new-google-access-token',
          expires_in: 3600,
        }),
      });

      const tokens = await refreshAccessToken(
        { refreshToken: ourRefreshToken, clientId, clientSecret },
        mockAuthConfig
      );

      expect(tokens.access_token).toBe('new-google-access-token');
      expect(tokens.token_type).toBe('Bearer');
      expect(tokens.expires_in).toBe(3600);
      expect(tokens.scope).toBe('openid email https://www.googleapis.com/auth/spreadsheets');

      // Verify Google was called with correct params
      expect(fetch).toHaveBeenCalledOnce();
      const fetchCall = (fetch as any).mock.calls[0];
      expect(fetchCall[0]).toBe('https://oauth2.googleapis.com/token');
      const body = fetchCall[1].body;
      expect(body).toContain('grant_type=refresh_token');
      expect(body).toContain('refresh_token=google-refresh-token');
    });

    it('rejects unknown refresh_token', async () => {
      const { clientId, clientSecret } = registerTestClient();

      await expect(
        refreshAccessToken(
          { refreshToken: 'unknown-token', clientId, clientSecret },
          mockAuthConfig
        )
      ).rejects.toThrow('Invalid refresh_token');
    });

    it('rejects wrong client for refresh_token', async () => {
      const client1 = registerTestClient('https://a.example.com/cb');
      const client2 = registerTestClient('https://b.example.com/cb');

      const ourRefreshToken = 'refresh-for-client1';
      refreshTokens.set(ourRefreshToken, {
        clientId: client1.clientId,
        googleRefreshToken: 'google-refresh',
        createdAt: Date.now(),
      });

      await expect(
        refreshAccessToken(
          {
            refreshToken: ourRefreshToken,
            clientId: client2.clientId,
            clientSecret: client2.clientSecret,
          },
          mockAuthConfig
        )
      ).rejects.toThrow('Refresh token was not issued to this client');
    });

    it('throws when Google refresh fails', async () => {
      const { clientId, clientSecret } = registerTestClient();

      const ourRefreshToken = 'refresh-google-fail';
      refreshTokens.set(ourRefreshToken, {
        clientId,
        googleRefreshToken: 'expired-google-refresh',
        createdAt: Date.now(),
      });


      (fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'invalid_grant',
      });

      await expect(
        refreshAccessToken(
          { refreshToken: ourRefreshToken, clientId, clientSecret },
          mockAuthConfig
        )
      ).rejects.toThrow('Failed to refresh token with Google');
    });
  });

  describe('cleanupExpired', () => {
    it('removes expired pending Google auths', () => {
      pendingGoogleAuths.set('expired', {
        clientId: 'c1',
        redirectUri: 'https://example.com/cb',
        codeChallenge: 'challenge',
        codeChallengeMethod: 'S256',
        clientState: 'state',
        createdAt: Date.now() - 11 * 60 * 1000, // 11 minutes ago
      });

      pendingGoogleAuths.set('valid', {
        clientId: 'c2',
        redirectUri: 'https://example.com/cb',
        codeChallenge: 'challenge',
        codeChallengeMethod: 'S256',
        clientState: 'state',
        createdAt: Date.now(), // just created
      });

      cleanupExpired();

      expect(pendingGoogleAuths.has('expired')).toBe(false);
      expect(pendingGoogleAuths.has('valid')).toBe(true);
    });

    it('removes expired pending authorizations', () => {
      pendingAuthorizations.set('expired', {
        clientId: 'c1',
        redirectUri: 'https://example.com/cb',
        codeChallenge: 'challenge',
        googleAccessToken: 'token',
        createdAt: Date.now() - 11 * 60 * 1000,
      });

      pendingAuthorizations.set('valid', {
        clientId: 'c2',
        redirectUri: 'https://example.com/cb',
        codeChallenge: 'challenge',
        googleAccessToken: 'token',
        createdAt: Date.now(),
      });

      cleanupExpired();

      expect(pendingAuthorizations.has('expired')).toBe(false);
      expect(pendingAuthorizations.has('valid')).toBe(true);
    });

    it('preserves refresh tokens (no TTL)', () => {
      refreshTokens.set('rt-1', {
        clientId: 'c1',
        googleRefreshToken: 'google-rt',
        createdAt: Date.now() - 30 * 24 * 60 * 60 * 1000, // 30 days old
      });

      cleanupExpired();

      expect(refreshTokens.has('rt-1')).toBe(true);
    });
  });
});
