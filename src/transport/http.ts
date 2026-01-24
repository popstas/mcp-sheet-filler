import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type Request, type Response } from 'express';
import { createAdapter, createServer } from '../server.js';
import { logger } from '../logger.js';
import { handlers } from '../tools/index.js';

export async function startHttpServer(): Promise<void> {
  const port = parseInt(process.env.PORT || '3000', 10);
  const host = process.env.HOST || '0.0.0.0';

  const adapter = await createAdapter();
  const server = createServer(adapter);

  const app = express();
  app.use(express.json());

  // Health check endpoint
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  // MCP endpoint: GET (SSE stream), POST (JSON-RPC), DELETE (session teardown)
  app.all('/mcp', async (req: Request, res: Response) => {
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
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  const httpServer = app.listen(port, host, () => {
    logger.info('server_started', {
      transport: 'http',
      host,
      port,
      tools: Object.keys(handlers),
    });
    console.log(`MCP HTTP server listening on http://${host}:${port}`);
    console.log(`Health check: http://${host}:${port}/health`);
    console.log(`MCP endpoint: http://${host}:${port}/mcp`);
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
