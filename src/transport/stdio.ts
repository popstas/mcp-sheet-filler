import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAdapter, createServer } from '../server.js';
import { logger } from '../logger.js';
import { handlers } from '../tools/index.js';

export async function startStdioServer(): Promise<void> {
  const adapter = await createAdapter();
  const server = createServer(adapter);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('server_started', { transport: 'stdio', tools: Object.keys(handlers) });
}
