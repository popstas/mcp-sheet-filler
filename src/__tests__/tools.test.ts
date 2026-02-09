import { describe, it, expect, beforeEach } from 'vitest';
import { handlers } from '../tools/index.js';
import { extractSheetIdFromUrl } from '../storage/sheets.js';
import type { StorageAdapter } from '../storage/adapter.js';
import type { Field, DataObject } from '../types.js';
import { FillerError } from '../types.js';

// In-memory mock adapter for testing
function createMockAdapter(objectKeyField: string = 'name'): StorageAdapter {
  let fields: Field[] = [];
  let objects: Map<string, DataObject> = new Map();

  return {
    async listFields(names?: string[]): Promise<Field[]> {
      if (names && names.length > 0) {
        return fields.filter((f) => names.includes(f.name));
      }
      return fields;
    },

    async getFieldsByNames(names: string[]): Promise<Field[]> {
      return fields.filter((f) => names.includes(f.name));
    },

    async addField(field: Field): Promise<void> {
      if (fields.some((f) => f.name === field.name)) {
        throw new FillerError('field_already_exists', `Field "${field.name}" already exists`);
      }
      fields.push(field);
    },

    async getObjectByName(name: string): Promise<DataObject | null> {
      return objects.get(name) || null;
    },

    async listObjects(): Promise<DataObject[]> {
      return Array.from(objects.values());
    },

    async addObjectByName(name: string): Promise<void> {
      if (objects.has(name)) {
        throw new FillerError('object_already_exists', `Object "${name}" already exists`);
      }
      objects.set(name, { name, values: { [objectKeyField]: name } });
    },

    async updateObjectFields(name: string, values: Record<string, string>): Promise<void> {
      const obj = objects.get(name);
      if (!obj) {
        throw new FillerError('object_not_found', `Object "${name}" not found`);
      }
      obj.values = { ...obj.values, ...values };
    },

    async getFieldNames(): Promise<string[]> {
      return fields.map((f) => f.name);
    },
  };
}

describe('Tool Handlers', () => {
  let adapter: StorageAdapter;

  beforeEach(async () => {
    adapter = createMockAdapter('name');
    // Setup test fields
    await adapter.addField({ name: 'name', type: 'string' });
    await adapter.addField({ name: 'email', type: 'email', auto: true, instructions: 'Find email' });
    await adapter.addField({ name: 'website', type: 'url', auto: true, instructions: 'Find website' });
    await adapter.addField({ name: 'age', type: 'number' });
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

  describe('filler_get_object_by_name', () => {
    beforeEach(async () => {
      await adapter.addObjectByName('acme');
      await adapter.updateObjectFields('acme', { email: 'info@acme.com' });
    });

    it('gets object by name with missing auto fields', async () => {
      const result = await handlers.filler_get_object_by_name({ name: 'acme' }, adapter);

      expect(result.found).toBe(true);
      expect(result.object?.name).toBe('acme');
      expect(result.object?.values.email).toBe('info@acme.com');
      // email is set, website is missing (both are auto fields)
      expect(result.missing).toHaveLength(1);
      expect(result.missing?.[0].name).toBe('website');
    });

    it('returns found=false for non-existent object', async () => {
      const result = await handlers.filler_get_object_by_name({ name: 'nonexistent' }, adapter);

      expect(result.found).toBe(false);
      expect(result.object).toBeUndefined();
      expect(result.missing).toBeUndefined();
    });

    it('includes field metadata by default', async () => {
      const result = await handlers.filler_get_object_by_name({ name: 'acme' }, adapter);

      expect(result.missing?.[0].instructions).toBeDefined();
      expect(result.missing?.[0].type).toBeDefined();
    });

    it('excludes field metadata when include_field_meta is false', async () => {
      const result = await handlers.filler_get_object_by_name(
        { name: 'acme', include_field_meta: false },
        adapter
      );

      expect(result.missing?.[0]).toEqual({ name: 'website' });
    });

    it('returns empty missing array when all auto fields are filled', async () => {
      await adapter.updateObjectFields('acme', { website: 'https://acme.com' });

      const result = await handlers.filler_get_object_by_name({ name: 'acme' }, adapter);

      expect(result.found).toBe(true);
      expect(result.missing).toHaveLength(0);
    });
  });

  describe('filler_add_object_by_name', () => {
    it('creates a new object with simple return type', async () => {
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

  describe('filler_save_objects_no_overwrite', () => {
    beforeEach(async () => {
      await adapter.addObjectByName('acme');
      await adapter.updateObjectFields('acme', { email: 'existing@acme.com' });
      await adapter.addObjectByName('globex');
    });

    it('saves values for multiple objects', async () => {
      const result = await handlers.filler_save_objects_no_overwrite(
        {
          objects: [
            { name: 'acme', values: { website: 'https://acme.com' } },
            { name: 'globex', values: { email: 'info@globex.com', website: 'https://globex.com' } },
          ],
        },
        adapter
      );

      expect(result.results.acme).toEqual({ website: 'saved' });
      expect(result.results.globex).toEqual({ email: 'saved', website: 'saved' });

      const acme = await adapter.getObjectByName('acme');
      expect(acme?.values.website).toBe('https://acme.com');
      const globex = await adapter.getObjectByName('globex');
      expect(globex?.values.email).toBe('info@globex.com');
    });

    it('handles non-existent object gracefully', async () => {
      const result = await handlers.filler_save_objects_no_overwrite(
        {
          objects: [
            { name: 'acme', values: { website: 'https://acme.com' } },
            { name: 'nonexistent', values: { email: 'test@test.com' } },
          ],
        },
        adapter
      );

      expect(result.results.acme).toEqual({ website: 'saved' });
      expect(result.results.nonexistent).toEqual({ error: 'Object "nonexistent" not found' });
    });

    it('skips already-set values across objects', async () => {
      const result = await handlers.filler_save_objects_no_overwrite(
        {
          objects: [
            { name: 'acme', values: { email: 'new@acme.com' } },
          ],
        },
        adapter
      );

      expect(result.results.acme).toEqual({ email: 'skipped_already_set' });
      const acme = await adapter.getObjectByName('acme');
      expect(acme?.values.email).toBe('existing@acme.com');
    });

    it('rejects unknown fields and invalid types', async () => {
      const result = await handlers.filler_save_objects_no_overwrite(
        {
          objects: [
            { name: 'globex', values: { unknown: 'val', website: 'not a url' } },
          ],
        },
        adapter
      );

      expect(result.results.globex).toEqual({
        unknown: 'rejected_unknown_field',
        website: 'rejected_invalid_type',
      });
    });

    it('handles mixed results across objects', async () => {
      const result = await handlers.filler_save_objects_no_overwrite(
        {
          objects: [
            { name: 'acme', values: { email: 'new@acme.com', website: 'https://acme.com' } },
            { name: 'nonexistent', values: { email: 'x@x.com' } },
            { name: 'globex', values: { age: 'not a number', email: 'info@globex.com' } },
          ],
        },
        adapter
      );

      expect(result.results.acme).toEqual({
        email: 'skipped_already_set',
        website: 'saved',
      });
      expect(result.results.nonexistent).toEqual({ error: 'Object "nonexistent" not found' });
      expect(result.results.globex).toEqual({
        age: 'rejected_invalid_type',
        email: 'saved',
      });
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

  describe('filler_get_next_missing_fields_objects', () => {
    it('returns multiple objects up to limit', async () => {
      await adapter.addObjectByName('obj1');
      await adapter.addObjectByName('obj2');
      await adapter.addObjectByName('obj3');

      const result = await handlers.filler_get_next_missing_fields_objects(
        { limit: 2 },
        adapter
      );

      expect(result.found).toBe(true);
      expect(result.objects).toHaveLength(2);
      expect(result.objects[0].object.name).toBe('obj1');
      expect(result.objects[1].object.name).toBe('obj2');
    });

    it('returns fewer than limit when not enough objects', async () => {
      await adapter.addObjectByName('obj1');

      const result = await handlers.filler_get_next_missing_fields_objects(
        { limit: 5 },
        adapter
      );

      expect(result.found).toBe(true);
      expect(result.objects).toHaveLength(1);
      expect(result.objects[0].object.name).toBe('obj1');
      expect(result.objects[0].missing.length).toBeGreaterThan(0);
    });

    it('returns found=false when no missing fields', async () => {
      await adapter.addObjectByName('obj1');
      await adapter.updateObjectFields('obj1', {
        email: 'a@b.com',
        website: 'https://example.com',
      });

      const result = await handlers.filler_get_next_missing_fields_objects(
        { limit: 5 },
        adapter
      );

      expect(result.found).toBe(false);
      expect(result.objects).toHaveLength(0);
    });

    it('returns found=false when no auto fields exist', async () => {
      // Create adapter with no auto fields
      const plainAdapter = createMockAdapter('name');
      await plainAdapter.addField({ name: 'name', type: 'string' });
      await plainAdapter.addField({ name: 'manual', type: 'string' });
      await plainAdapter.addObjectByName('obj1');

      const result = await handlers.filler_get_next_missing_fields_objects(
        { limit: 5 },
        plainAdapter
      );

      expect(result.found).toBe(false);
      expect(result.objects).toHaveLength(0);
    });

    it('respects include_field_meta=false', async () => {
      await adapter.addObjectByName('obj1');

      const result = await handlers.filler_get_next_missing_fields_objects(
        { limit: 5, include_field_meta: false },
        adapter
      );

      expect(result.found).toBe(true);
      expect(result.objects[0].missing[0]).toEqual({ name: 'email' });
      expect(result.objects[0].missing[0]).not.toHaveProperty('instructions');
    });

    it('skips objects with all auto fields filled', async () => {
      await adapter.addObjectByName('filled');
      await adapter.updateObjectFields('filled', {
        email: 'a@b.com',
        website: 'https://example.com',
      });
      await adapter.addObjectByName('unfilled');

      const result = await handlers.filler_get_next_missing_fields_objects(
        { limit: 5 },
        adapter
      );

      expect(result.found).toBe(true);
      expect(result.objects).toHaveLength(1);
      expect(result.objects[0].object.name).toBe('unfilled');
    });
  });

  describe('filler_init', () => {
    it('throws backend_not_configured when adapter lacks initSheet', async () => {
      // Base mock adapter doesn't have initSheet
      await expect(handlers.filler_init({}, adapter)).rejects.toThrow(FillerError);

      try {
        await handlers.filler_init({}, adapter);
      } catch (error) {
        expect((error as FillerError).code).toBe('backend_not_configured');
        expect((error as FillerError).message).toContain('sheets backend');
      }
    });

    it('returns success with tab and key info when initSheet is present', async () => {
      const mockAdapter: StorageAdapter = {
        ...adapter,
        async initSheet() {
          return { fieldsTab: 'fields', dataTab: 'Sheet1', keyField: 'name' };
        },
      };

      const result = await handlers.filler_init({}, mockAdapter);

      expect(result.success).toBe(true);
      expect(result.fieldsTab).toBe('fields');
      expect(result.dataTab).toBe('Sheet1');
      expect(result.keyField).toBe('name');
    });

    it('returns success with message when fields tab already exists', async () => {
      const mockAdapter: StorageAdapter = {
        ...adapter,
        async initSheet() {
          return { fieldsTab: 'fields', dataTab: 'Sheet1', keyField: 'name', alreadyExists: true };
        },
      };

      const result = await handlers.filler_init({}, mockAdapter);

      expect(result.success).toBe(true);
      expect(result.message).toContain('already exists');
    });
  });

  describe('filler_use_sheet_id', () => {
    it('throws error when backend does not support setSheetId', async () => {
      // Mock adapter doesn't have setSheetId
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
