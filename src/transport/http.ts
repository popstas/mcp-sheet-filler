import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type Request, type Response } from 'express';
import { createAdapter, createServer } from '../server.js';
import { logger } from '../logger.js';
import { handlers } from '../tools/index.js';
import { requestContext } from '../context.js';
import { getConfigFromEnv } from '../storage/adapter.js';
import type { AuthConfig } from '../auth/types.js';
import { generateProtectedResourceMetadata, getMetadataUrl } from '../auth/metadata.js';
import { validateGoogleToken } from '../auth/token-validator.js';

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
  // Exclude filler_google_auth in HTTP mode - auth is handled via Authorization header
  const server = createServer(adapter, ['filler_google_auth']);

  const app = express();
  app.use(express.json());

  // Health check endpoint (no auth required)
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  // Protected Resource Metadata endpoint (RFC 9728)
  app.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
    const metadata = generateProtectedResourceMetadata(authConfig);
    res.json(metadata);
  });

  // MCP endpoint: GET (SSE stream), POST (JSON-RPC), DELETE (session teardown)
  app.all('/mcp', async (req: Request, res: Response) => {
    // Authenticate the request
    const auth = await authenticateRequest(req, res, authConfig);
    if (!auth) {
      return; // 401 already sent
    }

    logger.debug('http_request_user', { userId: auth.userId, email: auth.email });

    // Run request handler within user context (includes access token for Sheets API)
    await requestContext.run({ userId: auth.userId, email: auth.email, accessToken: auth.accessToken }, async () => {
      try {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // stateless mode
        });

        res.on('close', () => {
          transport.close();
        });

        await server.connect(transport);
        await transport.handleRequest(req, res, req.method === 'POST' ? req.body : undefined);
      } catch (error) {
        logger.error('http_request_error', {
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
    console.log(`Health check: http://${host}:${port}/health`);
    console.log(`MCP endpoint: http://${host}:${port}/mcp`);
    console.log(`Protected Resource Metadata: ${authConfig.resourceUrl}/.well-known/oauth-protected-resource`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('\nShutting down...');
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
