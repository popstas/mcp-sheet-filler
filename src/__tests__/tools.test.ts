import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handlers } from '../tools/index.js';
import { createSqliteAdapter } from '../storage/sqlite.js';
import { extractSheetIdFromUrl } from '../storage/sheets.js';
import type { StorageAdapter } from '../storage/adapter.js';
import { FillerError } from '../types.js';
import fs from 'fs';
import path from 'path';

describe('Tool Handlers', () => {
  const testDbPath = path.join(process.cwd(), 'test-tools-' + Date.now() + '.db');
  let adapter: StorageAdapter;

  beforeEach(async () => {
    adapter = createSqliteAdapter(testDbPath, 'name');
    // Setup test fields
    await adapter.addField({ name: 'name', type: 'string' });
    await adapter.addField({ name: 'email', type: 'email', auto: true, instructions: 'Find email' });
    await adapter.addField({ name: 'website', type: 'url', auto: true, instructions: 'Find website' });
    await adapter.addField({ name: 'age', type: 'number' });
  });

  afterEach(() => {
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  describe('filler_list_fields', () => {
    it('lists all fields', async () => {
      const result = await handlers.filler_list_fields({}, adapter);

      expect(result.fields).toHaveLength(4);
    });

    it('filters fields by names', async () => {
      const result = await handlers.filler_list_fields({ names: ['email', 'website'] }, adapter);

      expect(result.fields).toHaveLength(2);
      expect(result.fields.map((f) => f.name).sort()).toEqual(['email', 'website']);
    });

    it('excludes instructions when include_instructions is false', async () => {
      const result = await handlers.filler_list_fields(
        { include_instructions: false },
        adapter
      );

      expect(result.fields[0]).not.toHaveProperty('instructions');
    });
  });

  describe('filler_get_fields_by_names', () => {
    it('gets fields by names', async () => {
      const result = await handlers.filler_get_fields_by_names(
        { names: ['email'] },
        adapter
      );

      expect(result.fields).toHaveLength(1);
      expect(result.fields[0].name).toBe('email');
      expect(result.fields[0].instructions).toBe('Find email');
    });

    it('returns empty array for non-existent fields', async () => {
      const result = await handlers.filler_get_fields_by_names(
        { names: ['nonexistent'] },
        adapter
      );

      expect(result.fields).toEqual([]);
    });
  });

  describe('filler_add_field', () => {
    it('adds a new field', async () => {
      const result = await handlers.filler_add_field(
        { field: { name: 'phone', type: 'string', description: 'Phone number' } },
        adapter
      );

      expect(result.created).toBe(true);
      expect(result.field.name).toBe('phone');

      const fields = await adapter.getFieldsByNames(['phone']);
      expect(fields).toHaveLength(1);
    });

    it('throws error for duplicate field', async () => {
      await expect(
        handlers.filler_add_field({ field: { name: 'email' } }, adapter)
      ).rejects.toThrow(FillerError);

      try {
        await handlers.filler_add_field({ field: { name: 'email' } }, adapter);
      } catch (error) {
        expect(error).toBeInstanceOf(FillerError);
        expect((error as FillerError).code).toBe('field_already_exists');
      }
    });
  });

  describe('filler_get_object / filler_get_object_by_name', () => {
    beforeEach(async () => {
      await adapter.addObjectByName('acme');
      await adapter.updateObjectFields('acme', { email: 'info@acme.com' });
    });

    it('gets object by id', async () => {
      const result = await handlers.filler_get_object({ id: 'acme' }, adapter);

      expect(result.found).toBe(true);
      expect(result.object?.name).toBe('acme');
      expect(result.object?.values.email).toBe('info@acme.com');
    });

    it('gets object by name', async () => {
      const result = await handlers.filler_get_object_by_name({ name: 'acme' }, adapter);

      expect(result.found).toBe(true);
      expect(result.object?.name).toBe('acme');
    });

    it('returns found=false for non-existent object', async () => {
      const result = await handlers.filler_get_object({ id: 'nonexistent' }, adapter);

      expect(result.found).toBe(false);
      expect(result.object).toBeUndefined();
    });
  });

  describe('filler_add_object_by_name', () => {
    it('creates a new object', async () => {
      const result = await handlers.filler_add_object_by_name({ name: 'newobj' }, adapter);

      expect(result.created).toBe(true);
      expect(result.object.name).toBe('newobj');

      const obj = await adapter.getObjectByName('newobj');
      expect(obj).not.toBeNull();
    });

    it('throws error for duplicate object', async () => {
      await adapter.addObjectByName('existing');

      await expect(
        handlers.filler_add_object_by_name({ name: 'existing' }, adapter)
      ).rejects.toThrow(FillerError);

      try {
        await handlers.filler_add_object_by_name({ name: 'existing' }, adapter);
      } catch (error) {
        expect((error as FillerError).code).toBe('object_already_exists');
      }
    });
  });

  describe('filler_save_object_no_overwrite', () => {
    beforeEach(async () => {
      await adapter.addObjectByName('acme');
      await adapter.updateObjectFields('acme', { email: 'existing@acme.com' });
    });

    it('saves new values', async () => {
      const result = await handlers.filler_save_object_no_overwrite(
        { name: 'acme', values: { website: 'https://acme.com' } },
        adapter
      );

      expect(result.result.website).toBe('saved');

      const obj = await adapter.getObjectByName('acme');
      expect(obj?.values.website).toBe('https://acme.com');
    });

    it('skips already set values', async () => {
      const result = await handlers.filler_save_object_no_overwrite(
        { name: 'acme', values: { email: 'new@acme.com' } },
        adapter
      );

      expect(result.result.email).toBe('skipped_already_set');

      const obj = await adapter.getObjectByName('acme');
      expect(obj?.values.email).toBe('existing@acme.com');
    });

    it('rejects unknown fields', async () => {
      const result = await handlers.filler_save_object_no_overwrite(
        { name: 'acme', values: { unknown_field: 'value' } },
        adapter
      );

      expect(result.result.unknown_field).toBe('rejected_unknown_field');
    });

    it('rejects invalid type values', async () => {
      const result = await handlers.filler_save_object_no_overwrite(
        { name: 'acme', values: { website: 'not a url' } },
        adapter
      );

      expect(result.result.website).toBe('rejected_invalid_type');
    });

    it('throws error for non-existent object', async () => {
      await expect(
        handlers.filler_save_object_no_overwrite(
          { name: 'nonexistent', values: { email: 'test@test.com' } },
          adapter
        )
      ).rejects.toThrow(FillerError);
    });

    it('handles mixed results', async () => {
      const result = await handlers.filler_save_object_no_overwrite(
        {
          name: 'acme',
          values: {
            email: 'new@acme.com',        // skipped (already set)
            website: 'https://acme.com',   // saved
            age: 'not a number',           // rejected (invalid type)
            unknown: 'value',              // rejected (unknown field)
          },
        },
        adapter
      );

      expect(result.result.email).toBe('skipped_already_set');
      expect(result.result.website).toBe('saved');
      expect(result.result.age).toBe('rejected_invalid_type');
      expect(result.result.unknown).toBe('rejected_unknown_field');
    });
  });

  describe('filler_get_missing_auto_fields', () => {
    beforeEach(async () => {
      await adapter.addObjectByName('acme');
      await adapter.updateObjectFields('acme', { email: 'info@acme.com' });
    });

    it('returns empty auto fields', async () => {
      const result = await handlers.filler_get_missing_auto_fields(
        { name: 'acme' },
        adapter
      );

      // email is set, website is auto but empty
      expect(result.missing).toHaveLength(1);
      expect(result.missing[0].name).toBe('website');
    });

    it('includes field metadata by default', async () => {
      const result = await handlers.filler_get_missing_auto_fields(
        { name: 'acme' },
        adapter
      );

      expect(result.missing[0].instructions).toBe('Find website');
      expect(result.missing[0].type).toBe('url');
    });

    it('excludes field metadata when include_field_meta is false', async () => {
      const result = await handlers.filler_get_missing_auto_fields(
        { name: 'acme', include_field_meta: false },
        adapter
      );

      expect(result.missing[0]).toEqual({ name: 'website' });
    });

    it('returns empty array when all auto fields are filled', async () => {
      await adapter.updateObjectFields('acme', { website: 'https://acme.com' });

      const result = await handlers.filler_get_missing_auto_fields(
        { name: 'acme' },
        adapter
      );

      expect(result.missing).toHaveLength(0);
    });

    it('throws error for non-existent object', async () => {
      await expect(
        handlers.filler_get_missing_auto_fields({ name: 'nonexistent' }, adapter)
      ).rejects.toThrow(FillerError);
    });
  });

  describe('filler_get_next_missing_fields_object', () => {
    it('returns first object with missing auto fields', async () => {
      await adapter.addObjectByName('obj1');
      await adapter.updateObjectFields('obj1', { email: 'obj1@test.com', website: 'https://obj1.com' });
      await adapter.addObjectByName('obj2');
      await adapter.updateObjectFields('obj2', { email: 'obj2@test.com' }); // website missing

      const result = await handlers.filler_get_next_missing_fields_object({}, adapter);

      expect(result.found).toBe(true);
      expect(result.object?.name).toBe('obj2');
      expect(result.missing).toHaveLength(1);
      expect(result.missing?.[0].name).toBe('website');
    });

    it('returns found=false when no objects have missing auto fields', async () => {
      await adapter.addObjectByName('obj1');
      await adapter.updateObjectFields('obj1', { email: 'obj1@test.com', website: 'https://obj1.com' });

      const result = await handlers.filler_get_next_missing_fields_object({}, adapter);

      expect(result.found).toBe(false);
      expect(result.object).toBeUndefined();
    });

    it('returns found=false when no objects exist', async () => {
      const result = await handlers.filler_get_next_missing_fields_object({}, adapter);

      expect(result.found).toBe(false);
    });

    it('includes field metadata by default', async () => {
      await adapter.addObjectByName('obj1');

      const result = await handlers.filler_get_next_missing_fields_object({}, adapter);

      expect(result.found).toBe(true);
      expect(result.missing?.[0].instructions).toBeDefined();
    });

    it('excludes field metadata when include_field_meta is false', async () => {
      await adapter.addObjectByName('obj1');

      const result = await handlers.filler_get_next_missing_fields_object(
        { include_field_meta: false },
        adapter
      );

      expect(result.found).toBe(true);
      expect(result.missing?.[0]).toEqual({ name: 'email' });
    });
  });

  describe('filler_use_sheet_id', () => {
    it('throws error when backend does not support setSheetId', async () => {
      // SQLite adapter doesn't have setSheetId
      await expect(
        handlers.filler_use_sheet_id({ sheet_id: 'test-id' }, adapter)
      ).rejects.toThrow(FillerError);

      try {
        await handlers.filler_use_sheet_id({ sheet_id: 'test-id' }, adapter);
      } catch (error) {
        expect((error as FillerError).code).toBe('backend_not_configured');
        expect((error as FillerError).message).toContain('sheets backend');
      }
    });

    it('works with adapter that has setSheetId', async () => {
      // Create a mock adapter with setSheetId/getSheetId
      let currentSheetId = 'initial-id';
      const mockAdapter: StorageAdapter = {
        ...adapter,
        setSheetId(idOrUrl: string) {
          currentSheetId = idOrUrl;
        },
        getSheetId() {
          return currentSheetId;
        },
      };

      const result = await handlers.filler_use_sheet_id(
        { sheet_id: 'new-sheet-id' },
        mockAdapter
      );

      expect(result.success).toBe(true);
      expect(result.sheet_id).toBe('new-sheet-id');
    });
  });
});

describe('extractSheetIdFromUrl', () => {
  it('returns raw sheet ID as-is', () => {
    const result = extractSheetIdFromUrl('1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms');
    expect(result).toBe('1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms');
  });

  it('extracts ID from full Google Sheets URL', () => {
    const result = extractSheetIdFromUrl(
      'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit#gid=0'
    );
    expect(result).toBe('1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms');
  });

  it('extracts ID from URL without edit suffix', () => {
    const result = extractSheetIdFromUrl(
      'https://docs.google.com/spreadsheets/d/abc123-_xyz/'
    );
    expect(result).toBe('abc123-_xyz');
  });

  it('handles URL with query parameters', () => {
    const result = extractSheetIdFromUrl(
      'https://docs.google.com/spreadsheets/d/test_sheet_id/edit?usp=sharing'
    );
    expect(result).toBe('test_sheet_id');
  });

  it('trims whitespace', () => {
    const result = extractSheetIdFromUrl('  test-id-123  ');
    expect(result).toBe('test-id-123');
  });

  it('throws error for empty string', () => {
    expect(() => extractSheetIdFromUrl('')).toThrow(FillerError);
    expect(() => extractSheetIdFromUrl('   ')).toThrow(FillerError);
  });

  it('throws error for invalid URL format', () => {
    expect(() => extractSheetIdFromUrl('https://google.com/invalid/path')).toThrow(FillerError);
    expect(() => extractSheetIdFromUrl('/some/local/path')).toThrow(FillerError);
  });
});
