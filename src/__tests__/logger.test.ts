import { describe, it, expect } from 'vitest';
import { maskPrivateData } from '../logger.js';

describe('maskPrivateData', () => {
  it('returns primitives as-is', () => {
    expect(maskPrivateData(null)).toBe(null);
    expect(maskPrivateData(undefined)).toBe(undefined);
    expect(maskPrivateData(42)).toBe(42);
    expect(maskPrivateData('hello')).toBe('hello');
    expect(maskPrivateData(true)).toBe(true);
  });

  it('masks keys in MASK_KEYS with "***"', () => {
    const input = {
      sheetId: 'abc123',
      name: 'John',
      url: 'https://example.com',
      path: '/tmp/test',
      clientId: 'client-id-123',
      tab: 'Sheet1',
      host: 'localhost',
    };
    const result = maskPrivateData(input) as Record<string, unknown>;
    expect(result.sheetId).toBe('***');
    expect(result.name).toBe('***');
    expect(result.url).toBe('***');
    expect(result.path).toBe('***');
    expect(result.clientId).toBe('***');
    expect(result.tab).toBe('***');
    expect(result.host).toBe('***');
  });

  it('replaces values object entries with masked keys/values and _count', () => {
    const input = {
      values: { email: 'john@test.com', url: 'https://example.com', phone: '123' },
    };
    const result = maskPrivateData(input) as Record<string, unknown>;
    expect(result.values).toEqual({ '***': '***', _masked: true, _count: 3 });
  });

  it('masks results object the same way as values', () => {
    const input = {
      results: { 'Майами': { 'Воздух': 'saved' } },
    };
    const result = maskPrivateData(input) as Record<string, unknown>;
    expect(result.results).toEqual({ '***': '***', _masked: true, _count: 1 });
  });

  it('does not replace values if it is not a plain object', () => {
    expect((maskPrivateData({ values: 'string' }) as Record<string, unknown>).values).toBe('string');
    expect((maskPrivateData({ values: [1, 2] }) as Record<string, unknown>).values).toEqual([1, 2]);
    expect((maskPrivateData({ values: null }) as Record<string, unknown>).values).toBe(null);
  });

  it('recurses into nested objects by default', () => {
    const input = {
      args: { sheetId: 'abc', count: 5 },
      result: { name: 'test', found: true },
      body: { url: 'https://x.com', status: 200 },
      data: { path: '/tmp', level: 'info' },
      fields: { tab: 'Sheet1', type: 'string' },
      objects: [{ object: { name: 'City', values: { a: '1' } } }],
    };
    const result = maskPrivateData(input) as Record<string, unknown>;
    expect((result.args as Record<string, unknown>).sheetId).toBe('***');
    expect((result.args as Record<string, unknown>).count).toBe(5);
    expect((result.result as Record<string, unknown>).name).toBe('***');
    expect((result.result as Record<string, unknown>).found).toBe(true);
    expect((result.body as Record<string, unknown>).url).toBe('***');
    expect((result.body as Record<string, unknown>).status).toBe(200);
    expect((result.data as Record<string, unknown>).path).toBe('***');
    expect((result.data as Record<string, unknown>).level).toBe('info');
    expect((result.fields as Record<string, unknown>).tab).toBe('***');
    expect((result.fields as Record<string, unknown>).type).toBe('string');
    // Deep nesting: objects[0].object.name and objects[0].object.values
    const obj = (result.objects as Array<Record<string, unknown>>)[0].object as Record<string, unknown>;
    expect(obj.name).toBe('***');
    expect(obj.values).toEqual({ '***': '***', _masked: true, _count: 1 });
  });

  it('preserves allowed keys (userId, email, sessionId, counts, booleans, status)', () => {
    const input = {
      userId: 'user@example.com',
      email: 'user@example.com',
      sessionId: 'sess-123',
      count: 10,
      total: 50,
      found: true,
      authenticated: false,
      method: 'tools/call',
      transport: 'stdio',
      status: 'saved',
      statusCode: 200,
      level: 'info',
    };
    const result = maskPrivateData(input) as Record<string, unknown>;
    expect(result).toEqual(input);
  });

  it('handles nested objects', () => {
    const input = {
      args: {
        values: { a: '1', b: '2' },
        name: 'test',
      },
    };
    const result = maskPrivateData(input) as Record<string, Record<string, unknown>>;
    expect(result.args.name).toBe('***');
    expect(result.args.values).toEqual({ '***': '***', _masked: true, _count: 2 });
  });

  it('handles arrays', () => {
    const input = [
      { name: 'a', count: 1 },
      { name: 'b', count: 2 },
    ];
    const result = maskPrivateData(input) as Array<Record<string, unknown>>;
    expect(result).toEqual([
      { name: '***', count: 1 },
      { name: '***', count: 2 },
    ]);
  });

  it('masks all MASK_KEYS comprehensively', () => {
    const allMaskKeys = [
      'sheetId', 'sheet_id', 'resolvedId', 'spreadsheetId', 'input',
      'resourceUrl', 'verification_url', 'url', 'redirectUris', 'host',
      'name', 'names', 'objectKeyField',
      'path',
      'azp', 'expected', 'actual', 'clientId', 'user_code',
      'tab', 'fieldsTab', 'dataTab', 'keyField',
    ];
    const input: Record<string, string> = {};
    for (const key of allMaskKeys) {
      input[key] = 'sensitive-value';
    }
    const result = maskPrivateData(input) as Record<string, unknown>;
    for (const key of allMaskKeys) {
      expect(result[key], `expected ${key} to be masked`).toBe('***');
    }
  });
});
