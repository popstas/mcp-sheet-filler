import { appendFileSync } from 'fs';
import { getCurrentSessionId } from './context.js';

const DEBUG_LOG = process.env.DEBUG_LOG;
const LOG_MASK_PRIVATE = process.env.LOG_MASK_PRIVATE === 'true';

const MASK_KEYS = new Set([
  'sheetId', 'sheet_id', 'resolvedId', 'spreadsheetId', 'input',
  'resourceUrl', 'verification_url', 'url', 'redirectUris', 'host',
  'name', 'names', 'objectKeyField',
  'path',
  'azp', 'expected', 'actual', 'clientId', 'user_code',
  'tab', 'fieldsTab', 'dataTab', 'keyField',
]);

const MASK_OBJECT_KEYS = new Set(['values', 'results']);

export function maskPrivateData(data: unknown): unknown {
  if (data === null || data === undefined || typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map(item => maskPrivateData(item));
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (MASK_KEYS.has(key)) {
      result[key] = '***';
    } else if (MASK_OBJECT_KEYS.has(key) && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = { '***': '***', _masked: true, _count: Object.keys(value as Record<string, unknown>).length };
    } else {
      result[key] = maskPrivateData(value);
    }
  }
  return result;
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function writeLog(level: string, message: string, data?: unknown): void {
  if (!DEBUG_LOG) return;

  const safeData = LOG_MASK_PRIVATE && data !== undefined ? maskPrivateData(data) : data;
  const sessionId = getCurrentSessionId();

  const entry = {
    timestamp: formatTimestamp(),
    level,
    ...(sessionId && { sessionId }),
    message,
    ...(safeData !== undefined && { data: safeData }),
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
