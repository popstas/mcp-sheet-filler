import { describe, it, expect } from 'vitest';
import { isEmpty, normalizeValue, validateType, processSaveValues } from '../validation.js';
import type { Field } from '../types.js';

describe('isEmpty', () => {
  it('returns true for null', () => {
    expect(isEmpty(null)).toBe(true);
  });

  it('returns true for undefined', () => {
    expect(isEmpty(undefined)).toBe(true);
  });

  it('returns true for empty string', () => {
    expect(isEmpty('')).toBe(true);
  });

  it('returns true for whitespace-only string', () => {
    expect(isEmpty('   ')).toBe(true);
    expect(isEmpty('\t\n')).toBe(true);
  });

  it('returns false for "0"', () => {
    expect(isEmpty('0')).toBe(false);
  });

  it('returns false for 0', () => {
    expect(isEmpty(0)).toBe(false);
  });

  it('returns false for false', () => {
    expect(isEmpty(false)).toBe(false);
  });

  it('returns false for non-empty string', () => {
    expect(isEmpty('hello')).toBe(false);
    expect(isEmpty(' hello ')).toBe(false);
  });
});

describe('normalizeValue', () => {
  it('trims whitespace', () => {
    expect(normalizeValue('  hello  ')).toBe('hello');
    expect(normalizeValue('\thello\n')).toBe('hello');
  });

  it('preserves content', () => {
    expect(normalizeValue('hello world')).toBe('hello world');
  });
});

describe('validateType', () => {
  describe('string type', () => {
    it('accepts any string for string type', () => {
      expect(validateType('anything', 'string')).toBe(true);
      expect(validateType('', 'string')).toBe(true);
    });

    it('accepts any string for undefined type', () => {
      expect(validateType('anything', undefined)).toBe(true);
    });
  });

  describe('number type', () => {
    it('accepts valid numbers', () => {
      expect(validateType('123', 'number')).toBe(true);
      expect(validateType('-456', 'number')).toBe(true);
      expect(validateType('3.14', 'number')).toBe(true);
      expect(validateType('0', 'number')).toBe(true);
    });

    it('rejects invalid numbers', () => {
      expect(validateType('abc', 'number')).toBe(false);
      expect(validateType('', 'number')).toBe(false);
      expect(validateType('12abc', 'number')).toBe(false);
    });
  });

  describe('date type', () => {
    it('accepts valid ISO dates', () => {
      expect(validateType('2024-01-15', 'date')).toBe(true);
      expect(validateType('2024-12-31', 'date')).toBe(true);
    });

    it('rejects invalid dates', () => {
      expect(validateType('2024-1-15', 'date')).toBe(false);
      expect(validateType('01-15-2024', 'date')).toBe(false);
      expect(validateType('2024/01/15', 'date')).toBe(false);
      expect(validateType('not a date', 'date')).toBe(false);
    });
  });

  describe('datetime type', () => {
    it('accepts valid ISO datetimes', () => {
      expect(validateType('2024-01-15T10:30:00', 'datetime')).toBe(true);
      expect(validateType('2024-01-15T10:30:00Z', 'datetime')).toBe(true);
      expect(validateType('2024-01-15T10:30:00.000Z', 'datetime')).toBe(true);
    });

    it('rejects invalid datetimes', () => {
      expect(validateType('not a datetime', 'datetime')).toBe(false);
    });
  });

  describe('url type', () => {
    it('accepts valid URLs', () => {
      expect(validateType('https://example.com', 'url')).toBe(true);
      expect(validateType('http://example.com/path?query=1', 'url')).toBe(true);
      expect(validateType('ftp://files.example.com', 'url')).toBe(true);
    });

    it('rejects invalid URLs', () => {
      expect(validateType('not a url', 'url')).toBe(false);
      expect(validateType('example.com', 'url')).toBe(false);
    });
  });

  describe('email type', () => {
    it('accepts valid emails', () => {
      expect(validateType('user@example.com', 'email')).toBe(true);
      expect(validateType('user.name@sub.example.com', 'email')).toBe(true);
    });

    it('rejects invalid emails', () => {
      expect(validateType('not an email', 'email')).toBe(false);
      expect(validateType('user@', 'email')).toBe(false);
      expect(validateType('@example.com', 'email')).toBe(false);
    });
  });

  describe('json type', () => {
    it('accepts valid JSON', () => {
      expect(validateType('{"key": "value"}', 'json')).toBe(true);
      expect(validateType('[1, 2, 3]', 'json')).toBe(true);
      expect(validateType('"string"', 'json')).toBe(true);
      expect(validateType('123', 'json')).toBe(true);
      expect(validateType('null', 'json')).toBe(true);
    });

    it('rejects invalid JSON', () => {
      expect(validateType('{invalid}', 'json')).toBe(false);
      expect(validateType('not json', 'json')).toBe(false);
    });
  });

  describe('enum type', () => {
    it('accepts valid enum values', () => {
      expect(validateType('small', 'enum:small|medium|large')).toBe(true);
      expect(validateType('medium', 'enum:small|medium|large')).toBe(true);
      expect(validateType('large', 'enum:small|medium|large')).toBe(true);
    });

    it('rejects invalid enum values', () => {
      expect(validateType('extra-large', 'enum:small|medium|large')).toBe(false);
      expect(validateType('', 'enum:small|medium|large')).toBe(false);
    });
  });

  describe('unknown type', () => {
    it('accepts any value for unknown types', () => {
      expect(validateType('anything', 'unknown_type')).toBe(true);
    });
  });
});

describe('processSaveValues', () => {
  const fields: Field[] = [
    { name: 'name', type: 'string' },
    { name: 'age', type: 'number' },
    { name: 'email', type: 'email' },
    { name: 'size', type: 'enum:small|medium|large' },
  ];
  const knownFieldNames = new Set(['name', 'age', 'email', 'size']);

  it('saves values for empty fields', () => {
    const currentValues = { name: 'John' };
    const newValues = { age: '25', email: 'john@example.com' };

    const result = processSaveValues(newValues, currentValues, fields, knownFieldNames);

    expect(result.result.age).toBe('saved');
    expect(result.result.email).toBe('saved');
    expect(result.valuesToSave).toEqual({ age: '25', email: 'john@example.com' });
  });

  it('skips fields that are already set', () => {
    const currentValues = { name: 'John', age: '30' };
    const newValues = { age: '25' };

    const result = processSaveValues(newValues, currentValues, fields, knownFieldNames);

    expect(result.result.age).toBe('skipped_already_set');
    expect(result.valuesToSave).toEqual({});
  });

  it('rejects unknown fields', () => {
    const currentValues = {};
    const newValues = { unknown_field: 'value' };

    const result = processSaveValues(newValues, currentValues, fields, knownFieldNames);

    expect(result.result.unknown_field).toBe('rejected_unknown_field');
    expect(result.valuesToSave).toEqual({});
  });

  it('rejects invalid type values', () => {
    const currentValues = {};
    const newValues = { age: 'not a number', email: 'invalid email' };

    const result = processSaveValues(newValues, currentValues, fields, knownFieldNames);

    expect(result.result.age).toBe('rejected_invalid_type');
    expect(result.result.email).toBe('rejected_invalid_type');
    expect(result.valuesToSave).toEqual({});
  });

  it('handles mixed results', () => {
    const currentValues = { name: 'John' };
    const newValues = {
      name: 'Jane',           // already set
      age: '25',              // valid, will save
      email: 'invalid',       // invalid type
      unknown: 'value',       // unknown field
      size: 'medium',         // valid, will save
    };

    const result = processSaveValues(newValues, currentValues, fields, knownFieldNames);

    expect(result.result.name).toBe('skipped_already_set');
    expect(result.result.age).toBe('saved');
    expect(result.result.email).toBe('rejected_invalid_type');
    expect(result.result.unknown).toBe('rejected_unknown_field');
    expect(result.result.size).toBe('saved');
    expect(result.valuesToSave).toEqual({ age: '25', size: 'medium' });
  });

  it('normalizes values before saving', () => {
    const currentValues = {};
    const newValues = { name: '  John  ' };

    const result = processSaveValues(newValues, currentValues, fields, knownFieldNames);

    expect(result.valuesToSave.name).toBe('John');
  });

  it('treats whitespace-only current values as empty', () => {
    const currentValues = { name: '   ' };
    const newValues = { name: 'John' };

    const result = processSaveValues(newValues, currentValues, fields, knownFieldNames);

    expect(result.result.name).toBe('saved');
    expect(result.valuesToSave.name).toBe('John');
  });
});
