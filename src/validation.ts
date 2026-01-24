import type { Field, SaveStatus } from './types.js';
import { logger } from './logger.js';

/**
 * Check if a value is considered empty.
 * Empty: null, undefined, empty string, whitespace-only string.
 * Non-empty: 0, false, "0", any other value.
 */
export function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

/**
 * Normalize a value (trim whitespace).
 */
export function normalizeValue(value: string): string {
  return value.trim();
}

/**
 * Validate a value against a field type.
 * Returns true if valid, false otherwise.
 */
export function validateType(value: string, type: string | undefined): boolean {
  if (!type || type === 'string') return true;

  const trimmed = value.trim();
  let valid = true;

  switch (type) {
    case 'number':
      valid = !isNaN(Number(trimmed)) && trimmed !== '';
      break;

    case 'date':
      // ISO-8601 date: YYYY-MM-DD
      valid = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) && !isNaN(Date.parse(trimmed));
      break;

    case 'datetime':
      // ISO-8601 datetime
      valid = !isNaN(Date.parse(trimmed));
      break;

    case 'url':
      try {
        new URL(trimmed);
        valid = true;
      } catch {
        valid = false;
      }
      break;

    case 'email':
      valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
      break;

    case 'json':
      try {
        JSON.parse(trimmed);
        valid = true;
      } catch {
        valid = false;
      }
      break;

    default:
      // enum:val1|val2|val3
      if (type.startsWith('enum:')) {
        const allowedValues = type.slice(5).split('|');
        valid = allowedValues.includes(trimmed);
      }
  }

  if (!valid) {
    logger.debug('validation_type_failed', { type, valueLength: trimmed.length });
  }
  return valid;
}

export interface SaveResult {
  result: Record<string, SaveStatus>;
  valuesToSave: Record<string, string>;
}

/**
 * Process values for save_object_no_overwrite.
 * Returns which values to actually save and the status for each field.
 */
export function processSaveValues(
  values: Record<string, string>,
  currentValues: Record<string, string>,
  fields: Field[],
  knownFieldNames: Set<string>
): SaveResult {
  const result: Record<string, SaveStatus> = {};
  const valuesToSave: Record<string, string> = {};

  const fieldMap = new Map(fields.map((f) => [f.name, f]));

  for (const [fieldName, newValue] of Object.entries(values)) {
    // Check if field exists
    if (!knownFieldNames.has(fieldName)) {
      result[fieldName] = 'rejected_unknown_field';
      continue;
    }

    // Check if already set
    const currentValue = currentValues[fieldName];
    if (!isEmpty(currentValue)) {
      result[fieldName] = 'skipped_already_set';
      continue;
    }

    // Validate type
    const field = fieldMap.get(fieldName);
    const normalized = normalizeValue(newValue);
    if (!validateType(normalized, field?.type)) {
      result[fieldName] = 'rejected_invalid_type';
      continue;
    }

    // Accept
    result[fieldName] = 'saved';
    valuesToSave[fieldName] = normalized;
  }

  // Log processing summary
  const statusCounts: Record<string, number> = {};
  for (const status of Object.values(result)) {
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  }
  logger.debug('validation_process_save_values', { inputFields: Object.keys(values).length, statusCounts });

  return { result, valuesToSave };
}
