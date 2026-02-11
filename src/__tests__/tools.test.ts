import { describe, it, expect, beforeEach } from 'vitest';
import { handlers } from '../tools/index.js';
import { extractSheetIdFromUrl } from '../storage/sheets.js';
import type { StorageAdapter } from '../storage/adapter.js';
import type { Field, DataObject } from '../types.js';
import { FillerError } from '../types.js';

// In-memory mock adapter for testing
function createMockAdapter(objectKeyField: string = 'name'): StorageAdapter {
  const fields: Field[] = [];
  const objects: Map<string, DataObject> = new Map();

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

  describe('filler_add_fields', () => {
    it('adds a single field', async () => {
      const result = await handlers.filler_add_fields(
        { fields: [{ name: 'phone', type: 'string', description: 'Phone number' }] },
        adapter
      );

      expect(result.results.phone).toEqual({ created: true });

      const fields = await adapter.getFieldsByNames(['phone']);
      expect(fields).toHaveLength(1);
    });

    it('adds multiple fields', async () => {
      const result = await handlers.filler_add_fields(
        { fields: [
          { name: 'phone', type: 'string' },
          { name: 'address', type: 'string' },
        ] },
        adapter
      );

      expect(result.results.phone).toEqual({ created: true });
      expect(result.results.address).toEqual({ created: true });

      const fields = await adapter.getFieldsByNames(['phone', 'address']);
      expect(fields).toHaveLength(2);
    });

    it('returns error for duplicate field', async () => {
      const result = await handlers.filler_add_fields(
        { fields: [{ name: 'email' }] },
        adapter
      );

      expect(result.results.email).toEqual({ error: 'Field "email" already exists' });
    });

    it('handles mixed results (some new, some existing)', async () => {
      const result = await handlers.filler_add_fields(
        { fields: [
          { name: 'phone', type: 'string' },
          { name: 'email' }, // already exists
        ] },
        adapter
      );

      expect(result.results.phone).toEqual({ created: true });
      expect(result.results.email).toEqual({ error: 'Field "email" already exists' });
    });

    it('detects duplicates within input array', async () => {
      const result = await handlers.filler_add_fields(
        { fields: [
          { name: 'phone', type: 'string' },
          { name: 'phone', type: 'number' },
        ] },
        adapter
      );

      expect(result.results.phone).toEqual({ error: 'Duplicate field name in request' });
    });
  });

  describe('filler_get_objects_by_name', () => {
    beforeEach(async () => {
      await adapter.addObjectByName('acme');
      await adapter.updateObjectFields('acme', { email: 'info@acme.com' });
    });

    it('gets single object by name with missing auto fields', async () => {
      const result = await handlers.filler_get_objects_by_name({ names: ['acme'] }, adapter);

      expect(result.objects).toHaveLength(1);
      const obj = result.objects[0];
      expect(obj.found).toBe(true);
      if (obj.found) {
        expect(obj.object.name).toBe('acme');
        expect(obj.object.values.email).toBe('info@acme.com');
        expect(obj.missing).toHaveLength(1);
        expect(obj.missing[0].name).toBe('website');
      }
    });

    it('gets multiple objects at once', async () => {
      await adapter.addObjectByName('globex');
      const result = await handlers.filler_get_objects_by_name({ names: ['acme', 'globex'] }, adapter);

      expect(result.objects).toHaveLength(2);
      expect(result.objects[0].found).toBe(true);
      expect(result.objects[1].found).toBe(true);
    });

    it('returns found=false for non-existent object', async () => {
      const result = await handlers.filler_get_objects_by_name({ names: ['nonexistent'] }, adapter);

      expect(result.objects).toHaveLength(1);
      expect(result.objects[0].found).toBe(false);
      if (!result.objects[0].found) {
        expect(result.objects[0].name).toBe('nonexistent');
      }
    });

    it('handles mixed existing and non-existing objects', async () => {
      const result = await handlers.filler_get_objects_by_name({ names: ['acme', 'nonexistent'] }, adapter);

      expect(result.objects).toHaveLength(2);
      expect(result.objects[0].found).toBe(true);
      expect(result.objects[1].found).toBe(false);
    });

    it('includes field metadata only on first found object', async () => {
      await adapter.addObjectByName('globex');
      const result = await handlers.filler_get_objects_by_name(
        { names: ['acme', 'globex'], include_field_meta: true },
        adapter
      );

      expect(result.objects).toHaveLength(2);
      if (result.objects[0].found) {
        expect(result.objects[0].missing[0].instructions).toBeDefined();
        expect(result.objects[0].missing[0].type).toBeDefined();
      }
      if (result.objects[1].found) {
        expect(result.objects[1].missing[0]).toEqual({ name: 'email' });
        expect(result.objects[1].missing[0]).not.toHaveProperty('instructions');
      }
    });

    it('excludes field metadata when include_field_meta is false', async () => {
      const result = await handlers.filler_get_objects_by_name(
        { names: ['acme'], include_field_meta: false },
        adapter
      );

      if (result.objects[0].found) {
        expect(result.objects[0].missing[0]).toEqual({ name: 'website' });
      }
    });

    it('returns empty missing array when all auto fields are filled', async () => {
      await adapter.updateObjectFields('acme', { website: 'https://acme.com' });

      const result = await handlers.filler_get_objects_by_name({ names: ['acme'] }, adapter);

      if (result.objects[0].found) {
        expect(result.objects[0].missing).toHaveLength(0);
      }
    });
  });

  describe('filler_add_objects_by_name', () => {
    it('creates a single object', async () => {
      const result = await handlers.filler_add_objects_by_name({ names: ['newobj'] }, adapter);

      expect(result.results.newobj).toEqual({ created: true });

      const obj = await adapter.getObjectByName('newobj');
      expect(obj).not.toBeNull();
    });

    it('creates multiple objects', async () => {
      const result = await handlers.filler_add_objects_by_name({ names: ['obj1', 'obj2'] }, adapter);

      expect(result.results.obj1).toEqual({ created: true });
      expect(result.results.obj2).toEqual({ created: true });

      const obj1 = await adapter.getObjectByName('obj1');
      const obj2 = await adapter.getObjectByName('obj2');
      expect(obj1).not.toBeNull();
      expect(obj2).not.toBeNull();
    });

    it('returns error for duplicate object', async () => {
      await adapter.addObjectByName('existing');

      const result = await handlers.filler_add_objects_by_name({ names: ['existing'] }, adapter);

      expect(result.results.existing).toEqual({ error: 'Object "existing" already exists' });
    });

    it('handles mixed results (some new, some existing)', async () => {
      await adapter.addObjectByName('existing');

      const result = await handlers.filler_add_objects_by_name(
        { names: ['newobj', 'existing'] },
        adapter
      );

      expect(result.results.newobj).toEqual({ created: true });
      expect(result.results.existing).toEqual({ error: 'Object "existing" already exists' });
    });

    it('detects duplicates within input array', async () => {
      const result = await handlers.filler_add_objects_by_name(
        { names: ['obj1', 'obj1'] },
        adapter
      );

      expect(result.results.obj1).toEqual({ error: 'Duplicate name in request' });
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

    it('accepts comments without errors when adapter lacks batchSetCellNotes', async () => {
      const result = await handlers.filler_save_objects_no_overwrite(
        {
          objects: [
            { name: 'globex', values: { email: 'info@globex.com' }, comments: { email: 'Source: website' } },
          ],
        },
        adapter
      );

      expect(result.results.globex).toEqual({ email: 'saved' });
    });

    it('calls batchSetCellNotes when adapter supports it', async () => {
      const notesCalls: Array<{ notes: Array<{ name: string; comments: Record<string, string> }>; fields: Field[] }> = [];
      const mockAdapter: StorageAdapter = {
        ...adapter,
        async batchSetCellNotes(notes, fields) {
          notesCalls.push({ notes, fields });
        },
      };

      await handlers.filler_save_objects_no_overwrite(
        {
          objects: [
            { name: 'globex', values: { email: 'info@globex.com' }, comments: { email: 'Source: website' } },
          ],
        },
        mockAdapter
      );

      expect(notesCalls).toHaveLength(1);
      expect(notesCalls[0].notes).toEqual([
        { name: 'globex', comments: { email: 'Source: website' } },
      ]);
    });

    it('does not write comments for skipped_already_set fields', async () => {
      const notesCalls: unknown[] = [];
      const mockAdapter: StorageAdapter = {
        ...adapter,
        async batchSetCellNotes(notes, fields) {
          notesCalls.push({ notes, fields });
        },
      };

      // acme already has email set
      const result = await handlers.filler_save_objects_no_overwrite(
        {
          objects: [
            { name: 'acme', values: { email: 'new@acme.com' }, comments: { email: 'Should not be written' } },
          ],
        },
        mockAdapter
      );

      expect(result.results.acme).toEqual({ email: 'skipped_already_set' });
      expect(notesCalls).toHaveLength(0);
    });

    it('silently ignores comments for unknown fields', async () => {
      const notesCalls: unknown[] = [];
      const mockAdapter: StorageAdapter = {
        ...adapter,
        async batchSetCellNotes(notes, fields) {
          notesCalls.push({ notes, fields });
        },
      };

      await handlers.filler_save_objects_no_overwrite(
        {
          objects: [
            { name: 'globex', values: { unknown_field: 'val' }, comments: { unknown_field: 'Note' } },
          ],
        },
        mockAdapter
      );

      // unknown_field is rejected_unknown_field, so comment should not be written
      expect(notesCalls).toHaveLength(0);
    });

    it('does not call batchSetCellNotes when no comments provided', async () => {
      const notesCalls: unknown[] = [];
      const mockAdapter: StorageAdapter = {
        ...adapter,
        async batchSetCellNotes(notes, fields) {
          notesCalls.push({ notes, fields });
        },
      };

      await handlers.filler_save_objects_no_overwrite(
        {
          objects: [
            { name: 'globex', values: { email: 'info@globex.com' } },
          ],
        },
        mockAdapter
      );

      expect(notesCalls).toHaveLength(0);
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

    it('includes field meta only on first object when multiple returned', async () => {
      await adapter.addObjectByName('obj1');
      await adapter.addObjectByName('obj2');

      const result = await handlers.filler_get_next_missing_fields_objects(
        { limit: 2, include_field_meta: true },
        adapter
      );

      expect(result.found).toBe(true);
      expect(result.objects).toHaveLength(2);
      expect(result.objects[0].missing[0]).toMatchObject({
        name: 'email',
        type: expect.any(String),
        instructions: expect.anything(),
      });
      expect(result.objects[1].missing[0]).toEqual({ name: 'email' });
      expect(result.objects[1].missing[0]).not.toHaveProperty('instructions');
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

    it('returns count and remain when more unfilled than limit', async () => {
      await adapter.addObjectByName('obj1');
      await adapter.addObjectByName('obj2');
      await adapter.addObjectByName('obj3');
      await adapter.addObjectByName('obj4');
      await adapter.addObjectByName('obj5');

      const result = await handlers.filler_get_next_missing_fields_objects(
        { limit: 2 },
        adapter
      );

      expect(result.found).toBe(true);
      expect(result.objects).toHaveLength(2);
      expect(result.count).toBe(5);
      expect(result.remain).toBe(3);
    });

    it('respects skip_filled_fields=true', async () => {
      await adapter.addObjectByName('acme');
      await adapter.updateObjectFields('acme', { email: 'info@acme.com' });

      const result = await handlers.filler_get_next_missing_fields_objects(
        { limit: 1, skip_filled_fields: true },
        adapter
      );

      expect(result.found).toBe(true);
      expect(result.objects[0].object.name).toBe('acme');
      expect(result.objects[0].object.values).toEqual({});
      expect(result.objects[0].missing.length).toBeGreaterThan(0);
    });

    it('returns count=0 remain=0 when none unfilled', async () => {
      await adapter.addObjectByName('filled');
      await adapter.updateObjectFields('filled', {
        email: 'a@b.com',
        website: 'https://example.com',
      });

      const result = await handlers.filler_get_next_missing_fields_objects(
        { limit: 5 },
        adapter
      );

      expect(result.found).toBe(false);
      expect(result.objects).toHaveLength(0);
      expect(result.count).toBe(0);
      expect(result.remain).toBe(0);
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
