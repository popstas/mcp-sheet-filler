import { appendFileSync } from 'fs';

const DEBUG_LOG = process.env.DEBUG_LOG;

function formatTimestamp(): string {
  return new Date().toISOString();
}

function writeLog(level: string, message: string, data?: unknown): void {
  if (!DEBUG_LOG) return;

  const entry = {
    timestamp: formatTimestamp(),
    level,
    message,
    ...(data !== undefined && { data }),
  };

  try {
    appendFileSync(DEBUG_LOG, JSON.stringify(entry) + '\n');
  } catch {
    // Silently ignore logging errors to not break the main functionality
  }
}

export const logger = {
  info(message: string, data?: unknown): void {
    writeLog('info', message, data);
  },

  error(message: string, data?: unknown): void {
    writeLog('error', message, data);
  },

  debug(message: string, data?: unknown): void {
    writeLog('debug', message, data);
  },
};
