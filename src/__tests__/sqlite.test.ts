import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSqliteAdapter } from '../storage/sqlite.js';
import type { StorageAdapter } from '../storage/adapter.js';
import fs from 'fs';
import path from 'path';

describe('SQLite Adapter', () => {
  const testDbPath = path.join(process.cwd(), 'test-db-' + Date.now() + '.db');
  let adapter: StorageAdapter;

  beforeEach(() => {
    adapter = createSqliteAdapter(testDbPath, 'name');
  });

  afterEach(() => {
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  describe('fields operations', () => {
    it('adds and retrieves a field', async () => {
      await adapter.addField({
        name: 'email',
        description: 'Email address',
        auto: true,
        type: 'email',
        instructions: 'Find the email',
        example: 'user@example.com',
      });

      const fields = await adapter.getFieldsByNames(['email']);

      expect(fields).toHaveLength(1);
      expect(fields[0]).toEqual({
        name: 'email',
        description: 'Email address',
        auto: true,
        type: 'email',
        instructions: 'Find the email',
        example: 'user@example.com',
      });
    });

    it('lists all fields', async () => {
      await adapter.addField({ name: 'field1' });
      await adapter.addField({ name: 'field2' });
      await adapter.addField({ name: 'field3' });

      const fields = await adapter.listFields();

      expect(fields).toHaveLength(3);
      expect(fields.map((f) => f.name).sort()).toEqual(['field1', 'field2', 'field3']);
    });

    it('lists fields by names', async () => {
      await adapter.addField({ name: 'field1' });
      await adapter.addField({ name: 'field2' });
      await adapter.addField({ name: 'field3' });

      const fields = await adapter.listFields(['field1', 'field3']);

      expect(fields).toHaveLength(2);
      expect(fields.map((f) => f.name).sort()).toEqual(['field1', 'field3']);
    });

    it('returns empty array for non-existent fields', async () => {
      const fields = await adapter.getFieldsByNames(['nonexistent']);

      expect(fields).toEqual([]);
    });

    it('gets field names', async () => {
      await adapter.addField({ name: 'field1' });
      await adapter.addField({ name: 'field2' });

      const names = await adapter.getFieldNames();

      expect(names.sort()).toEqual(['field1', 'field2']);
    });

    it('handles field with minimal data', async () => {
      await adapter.addField({ name: 'minimal' });

      const fields = await adapter.getFieldsByNames(['minimal']);

      expect(fields[0]).toEqual({
        name: 'minimal',
        description: undefined,
        auto: false,
        type: 'string',
        instructions: undefined,
        example: undefined,
      });
    });
  });

  describe('objects operations', () => {
    it('adds and retrieves an object', async () => {
      await adapter.addObjectByName('test-object');

      const obj = await adapter.getObjectByName('test-object');

      expect(obj).toEqual({
        name: 'test-object',
        values: {},
      });
    });

    it('returns null for non-existent object', async () => {
      const obj = await adapter.getObjectByName('nonexistent');

      expect(obj).toBeNull();
    });

    it('updates object fields', async () => {
      await adapter.addObjectByName('test-object');
      await adapter.updateObjectFields('test-object', {
        field1: 'value1',
        field2: 'value2',
      });

      const obj = await adapter.getObjectByName('test-object');

      expect(obj?.values).toEqual({
        field1: 'value1',
        field2: 'value2',
      });
    });

    it('merges new fields with existing', async () => {
      await adapter.addObjectByName('test-object');
      await adapter.updateObjectFields('test-object', { field1: 'value1' });
      await adapter.updateObjectFields('test-object', { field2: 'value2' });

      const obj = await adapter.getObjectByName('test-object');

      expect(obj?.values).toEqual({
        field1: 'value1',
        field2: 'value2',
      });
    });

    it('overwrites existing field values', async () => {
      await adapter.addObjectByName('test-object');
      await adapter.updateObjectFields('test-object', { field1: 'old' });
      await adapter.updateObjectFields('test-object', { field1: 'new' });

      const obj = await adapter.getObjectByName('test-object');

      expect(obj?.values.field1).toBe('new');
    });

    it('does nothing when updating non-existent object', async () => {
      // Should not throw
      await adapter.updateObjectFields('nonexistent', { field1: 'value1' });

      const obj = await adapter.getObjectByName('nonexistent');
      expect(obj).toBeNull();
    });
  });

  describe('full workflow', () => {
    it('supports add field -> add object -> update -> retrieve flow', async () => {
      // Add fields
      await adapter.addField({ name: 'name', type: 'string' });
      await adapter.addField({ name: 'email', type: 'email', auto: true });
      await adapter.addField({ name: 'age', type: 'number', auto: true });

      // Add object
      await adapter.addObjectByName('john');

      // Update some fields
      await adapter.updateObjectFields('john', {
        email: 'john@example.com',
      });

      // Retrieve and verify
      const obj = await adapter.getObjectByName('john');
      expect(obj?.values.email).toBe('john@example.com');

      // Check field names
      const fieldNames = await adapter.getFieldNames();
      expect(fieldNames).toContain('name');
      expect(fieldNames).toContain('email');
      expect(fieldNames).toContain('age');
    });
  });
});
