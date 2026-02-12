import crypto from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type Request, type Response } from 'express';
import { createAdapter, createServer } from '../server.js';
import { logger } from '../logger.js';
import { handlers } from '../tools/index.js';
import { requestContext, type RequestContext } from '../context.js';
import { getConfigFromEnv } from '../storage/adapter.js';
import type { AuthConfig } from '../auth/types.js';
import { generateProtectedResourceMetadata, getMetadataUrl } from '../auth/metadata.js';
import { validateGoogleToken } from '../auth/token-validator.js';
import { createAuthorizationServerRouter } from '../auth/authorization-server-routes.js';
import { cleanupExpired } from '../auth/authorization-server.js';
import { getHealthData, cleanupStaleUsers } from '../rate-limit/index.js';

/**
 * Get auth configuration from environment.
 * Returns null if required config is missing.
 */
function getAuthConfig(): AuthConfig | null {
  const config = getConfigFromEnv();

  if (!config.resourceUrl) {
    return null;
  }
  if (!config.googleOAuthClientId || !config.googleOAuthClientSecret) {
    return null;
  }

  return {
    resourceUrl: config.resourceUrl,
    clientId: config.googleOAuthClientId,
    clientSecret: config.googleOAuthClientSecret,
  };
}

/**
 * Send 401 response with RFC 9728 compliant WWW-Authenticate header.
 */
function send401(res: Response, authConfig: AuthConfig, error?: string): void {
  const metadataUrl = getMetadataUrl(authConfig.resourceUrl);
  let wwwAuth = `Bearer resource_metadata="${metadataUrl}"`;
  if (error) {
    wwwAuth += `, error="${error}"`;
  }

  res.setHeader('WWW-Authenticate', wwwAuth);
  res.status(401).json({ error: 'unauthorized', message: error || 'Authentication required' });
}

/**
 * Authenticate a request using OAuth bearer token.
 * Returns the validated user info or sends 401 and returns null.
 */
async function authenticateRequest(
  req: Request,
  res: Response,
  authConfig: AuthConfig
): Promise<{ userId: string; email?: string; accessToken: string } | null> {
  const authHeader = req.headers['authorization'];

  if (!authHeader || typeof authHeader !== 'string') {
    send401(res, authConfig, 'missing_token');
    return null;
  }

  if (!authHeader.startsWith('Bearer ')) {
    send401(res, authConfig, 'invalid_request');
    return null;
  }

  const token = authHeader.slice(7);
  if (!token) {
    send401(res, authConfig, 'missing_token');
    return null;
  }

  const result = await validateGoogleToken(token, authConfig.clientId);

  if (!result.valid) {
    send401(res, authConfig, result.error || 'invalid_token');
    return null;
  }

  return {
    userId: result.userId!,
    email: result.email,
    accessToken: token,
  };
}

export async function startHttpServer(): Promise<void> {
  const port = parseInt(process.env.PORT || '3000', 10);
  const host = process.env.HOST || '0.0.0.0';

  const authConfig = getAuthConfig();

  // Validate required configuration for HTTP transport
  if (!authConfig) {
    console.error('HTTP transport requires the following environment variables:');
    console.error('  - RESOURCE_URL: Public URL of this server');
    console.error('  - GOOGLE_OAUTH_CLIENT_ID: Google OAuth client ID');
    console.error('  - GOOGLE_OAUTH_CLIENT_SECRET: Google OAuth client secret');
    process.exit(1);
  }

  const adapter = await createAdapter();
  const disableSession = !!process.env.DISABLE_SESSION_ID;

  // Session store: session ID -> transport (only used when sessions are enabled)
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false }));

  // Health check endpoint (no auth required)
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', ...getHealthData() });
  });

  // Protected Resource Metadata endpoint (RFC 9728)
  app.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
    const metadata = generateProtectedResourceMetadata(authConfig);
    res.json(metadata);
  });

  // OAuth Authorization Server routes (DCR, authorize, callback, token)
  const authRouter = createAuthorizationServerRouter(authConfig);
  app.use(authRouter);

  // Periodic cleanup of expired authorization entries (every 5 minutes)
  const cleanupInterval = setInterval(cleanupExpired, 5 * 60 * 1000);

  // Periodic cleanup of stale user rate-limit metrics (every 60 seconds)
  const metricsCleanupInterval = setInterval(() => {
    const result = cleanupStaleUsers();
    if (result.removedUsers > 0) {
      logger.debug('rate.cleanup', result);
    }
  }, 60_000);

  // MCP endpoint: GET (SSE stream), POST (JSON-RPC), DELETE (session teardown)
  app.all('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // Wrap entire handler in request context so all logs (including auth) get sessionId
    const ctx = { userId: '', sessionId: sessionId ?? undefined } as RequestContext;
    await requestContext.run(ctx, async () => {
      // Authenticate the request
      const auth = await authenticateRequest(req, res, authConfig);
      if (!auth) {
        return; // 401 already sent
      }

      // Update context with auth info
      ctx.userId = auth.userId;
      ctx.email = auth.email;
      ctx.accessToken = auth.accessToken;

      logger.debug('http_request', {
        method: req.method,
        userId: auth.userId,
        email: auth.email,
        body: req.method === 'POST' ? req.body?.method : undefined,
      });

      // Log response status when finished
      res.on('finish', () => {
        if (res.statusCode >= 400) {
          logger.error('http_response_error', {
            method: req.method,
            userId: auth.userId,
            statusCode: res.statusCode,
            body: req.method === 'POST' ? req.body?.method : undefined,
          });
        } else {
          logger.debug('http_response', {
            method: req.method,
            userId: auth.userId,
            statusCode: res.statusCode,
          });
        }
      });

      try {
        if (disableSession) {
          // Stateless mode: new transport + server per request
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
          });
          res.on('close', () => transport.close());
          const sessionServer = createServer(adapter, ['filler_google_auth']);
          await sessionServer.connect(transport);
          await transport.handleRequest(req, res, req.method === 'POST' ? req.body : undefined);
        } else if (sessionId && sessions.has(sessionId)) {
          // Existing session: reuse transport
          const transport = sessions.get(sessionId)!;
          await transport.handleRequest(req, res, req.method === 'POST' ? req.body : undefined);
        } else if (!sessionId) {
          // New session: create transport + server, store by session ID
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (sessionId) => {
              sessions.set(sessionId, transport);
              logger.debug('session_created', { sessionId });
            },
          });

          transport.onclose = () => {
            if (transport.sessionId) {
              sessions.delete(transport.sessionId);
              logger.debug('session_closed', { sessionId: transport.sessionId });
            }
          };

          const sessionServer = createServer(adapter, ['filler_google_auth']);
          await sessionServer.connect(transport);
          await transport.handleRequest(req, res, req.method === 'POST' ? req.body : undefined);
        } else {
          // Client sent unknown session ID
          res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: No active session found for the provided session ID' },
            id: null,
          });
        }
      } catch (error) {
        logger.error('http_request_error', {
          method: req.method,
          userId: auth.userId,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal server error' });
        }
      }
    });
  });

  const httpServer = app.listen(port, host, () => {
    logger.info('server_started', {
      transport: 'http',
      host,
      port,
      resourceUrl: authConfig.resourceUrl,
      tools: Object.keys(handlers),
    });
    console.log(`MCP HTTP server listening on http://${host}:${port}`);
    console.log(`Health check: ${authConfig.resourceUrl}/health`);
    console.log(`MCP endpoint: ${authConfig.resourceUrl}/mcp`);
    console.log(`Protected Resource Metadata: ${authConfig.resourceUrl}/.well-known/oauth-protected-resource`);
    console.log(`Authorization Server Metadata: ${authConfig.resourceUrl}/.well-known/oauth-authorization-server`);
    console.log(`Client Registration: ${authConfig.resourceUrl}/auth/register`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('\nShutting down...');
    clearInterval(cleanupInterval);
    clearInterval(metricsCleanupInterval);
    httpServer.close(() => {
      logger.info('server_stopped', { transport: 'http' });
      process.exit(0);
    });

    // Force exit after timeout
    setTimeout(() => {
      console.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
