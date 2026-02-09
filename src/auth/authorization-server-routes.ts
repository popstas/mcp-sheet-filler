import { Router, type Request, type Response } from 'express';
import { logger } from '../logger.js';
import type { AuthConfig, DCRRequest } from './types.js';
import {
  generateAuthServerMetadata,
  registerClient,
  createPendingGoogleAuth,
  handleGoogleCallback,
  exchangeCodeForTokens,
  refreshAccessToken,
} from './authorization-server.js';

/**
 * Create Express router for OAuth Authorization Server endpoints.
 */
export function createAuthorizationServerRouter(authConfig: AuthConfig): Router {
  const router = Router();

  // RFC 8414 Authorization Server Metadata
  router.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
    const metadata = generateAuthServerMetadata(authConfig.resourceUrl);
    res.json(metadata);
  });

  // Dynamic Client Registration (RFC 7591)
  router.post('/auth/register', (req: Request, res: Response) => {
    try {
      const request = req.body as DCRRequest;
      const response = registerClient(request);
      res.status(201).json(response);
    } catch (error) {
      logger.error('dcr_failed', { error: error instanceof Error ? error.message : String(error) });
      res.status(400).json({
        error: 'invalid_client_metadata',
        error_description: error instanceof Error ? error.message : 'Registration failed',
      });
    }
  });

  // Authorization endpoint — redirects to Google consent
  router.get('/auth', (req: Request, res: Response) => {
    try {
      const clientId = req.query.client_id as string;
      const redirectUri = req.query.redirect_uri as string;
      const codeChallenge = req.query.code_challenge as string;
      const codeChallengeMethod = req.query.code_challenge_method as string;
      const state = req.query.state as string;
      const responseType = req.query.response_type as string;

      if (!clientId || !redirectUri || !codeChallenge || !state) {
        res.status(400).json({
          error: 'invalid_request',
          error_description: 'Missing required parameters: client_id, redirect_uri, code_challenge, state',
        });
        return;
      }

      if (responseType && responseType !== 'code') {
        res.status(400).json({
          error: 'unsupported_response_type',
          error_description: 'Only response_type=code is supported',
        });
        return;
      }

      const { googleAuthUrl } = createPendingGoogleAuth(
        {
          clientId,
          redirectUri,
          codeChallenge,
          codeChallengeMethod: codeChallengeMethod || 'S256',
          state,
        },
        authConfig
      );

      res.redirect(302, googleAuthUrl);
    } catch (error) {
      logger.error('auth_endpoint_failed', { error: error instanceof Error ? error.message : String(error) });
      res.status(400).json({
        error: 'invalid_request',
        error_description: error instanceof Error ? error.message : 'Authorization failed',
      });
    }
  });

  // Google OAuth callback — exchanges Google code, redirects to client
  router.get('/auth/callback', async (req: Request, res: Response) => {
    try {
      const state = req.query.state as string;
      const code = req.query.code as string;
      const error = req.query.error as string;

      if (error) {
        logger.error('google_auth_error', { error, description: req.query.error_description });
        res.status(400).json({
          error: 'access_denied',
          error_description: (req.query.error_description as string) || 'Google authorization denied',
        });
        return;
      }

      if (!state || !code) {
        res.status(400).json({
          error: 'invalid_request',
          error_description: 'Missing state or code parameter',
        });
        return;
      }

      const { redirectUrl } = await handleGoogleCallback(state, code, authConfig);
      res.redirect(302, redirectUrl);
    } catch (error) {
      logger.error('auth_callback_failed', { error: error instanceof Error ? error.message : String(error) });
      res.status(400).json({
        error: 'server_error',
        error_description: error instanceof Error ? error.message : 'Callback processing failed',
      });
    }
  });

  // Token endpoint — code exchange and refresh
  router.post('/auth/token', async (req: Request, res: Response) => {
    try {
      const grantType = req.body.grant_type as string;

      if (grantType === 'authorization_code') {
        const code = req.body.code as string;
        const clientId = req.body.client_id as string;
        const clientSecret = req.body.client_secret as string;
        const redirectUri = req.body.redirect_uri as string;
        const codeVerifier = req.body.code_verifier as string;

        if (!code || !clientId || !clientSecret || !redirectUri || !codeVerifier) {
          res.status(400).json({
            error: 'invalid_request',
            error_description: 'Missing required parameters: code, client_id, client_secret, redirect_uri, code_verifier',
          });
          return;
        }

        const tokens = exchangeCodeForTokens({
          code,
          clientId,
          clientSecret,
          redirectUri,
          codeVerifier,
        });

        res.json(tokens);
      } else if (grantType === 'refresh_token') {
        const refreshToken = req.body.refresh_token as string;
        const clientId = req.body.client_id as string;
        const clientSecret = req.body.client_secret as string;

        if (!refreshToken || !clientId || !clientSecret) {
          res.status(400).json({
            error: 'invalid_request',
            error_description: 'Missing required parameters: refresh_token, client_id, client_secret',
          });
          return;
        }

        const tokens = await refreshAccessToken(
          { refreshToken, clientId, clientSecret },
          authConfig
        );

        res.json(tokens);
      } else {
        res.status(400).json({
          error: 'unsupported_grant_type',
          error_description: 'Supported grant types: authorization_code, refresh_token',
        });
      }
    } catch (error) {
      logger.error('token_endpoint_failed', { error: error instanceof Error ? error.message : String(error) });
      res.status(400).json({
        error: 'invalid_grant',
        error_description: error instanceof Error ? error.message : 'Token exchange failed',
      });
    }
  });

  return router;
}
