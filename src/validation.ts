import type { Field, SaveStatus } from './types.js';

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

  switch (type) {
    case 'number':
      return !isNaN(Number(trimmed)) && trimmed !== '';

    case 'date':
      // ISO-8601 date: YYYY-MM-DD
      return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) && !isNaN(Date.parse(trimmed));

    case 'datetime':
      // ISO-8601 datetime
      return !isNaN(Date.parse(trimmed));

    case 'url':
      try {
        new URL(trimmed);
        return true;
      } catch {
        return false;
      }

    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);

    case 'json':
      try {
        JSON.parse(trimmed);
        return true;
      } catch {
        return false;
      }

    default:
      // enum:val1|val2|val3
      if (type.startsWith('enum:')) {
        const allowedValues = type.slice(5).split('|');
        return allowedValues.includes(trimmed);
      }
      return true;
  }
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

  return { result, valuesToSave };
}
