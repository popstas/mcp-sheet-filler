#!/usr/bin/env node

import { logger } from './logger.js';

const transport = process.env.TRANSPORT || 'stdio';

// Check for CLI mode
if (process.argv.includes('auth')) {
  // Run OAuth CLI
  import('./auth/cli.js').catch((error) => {
    console.error('Failed to run auth CLI:', error);
    process.exit(1);
  });
} else if (transport === 'http') {
  // Run HTTP server
  import('./transport/http.js')
    .then((m) => m.startHttpServer())
    .catch((error) => {
      logger.error('fatal_error', { error: error instanceof Error ? error.message : String(error) });
      console.error('Fatal error:', error);
      process.exit(1);
    });
} else {
  // Run stdio server (default)
  import('./transport/stdio.js')
    .then((m) => m.startStdioServer())
    .catch((error) => {
      logger.error('fatal_error', { error: error instanceof Error ? error.message : String(error) });
      console.error('Fatal error:', error);
      process.exit(1);
    });
}
