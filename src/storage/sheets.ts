import type { StorageAdapter, StorageConfig } from './adapter.js';
import type { Field, DataObject } from '../types.js';
import { FillerError } from '../types.js';

// Stub implementation - to be completed
export function createSheetsAdapter(_config: StorageConfig): StorageAdapter {
  throw new FillerError(
    'backend_not_configured',
    'Google Sheets adapter not yet implemented'
  );

  // TODO: Implement Google Sheets adapter
  // const adapter: StorageAdapter = { ... };
  // return adapter;
}
