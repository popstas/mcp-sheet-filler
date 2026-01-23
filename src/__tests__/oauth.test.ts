import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  loadTokens,
  saveTokens,
  isTokenExpired,
  getDefaultTokenPath,
  type OAuthTokens,
} from '../auth/oauth.js';

describe('OAuth token management', () => {
  let tempDir: string;
  let tempTokenPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-test-'));
    tempTokenPath = path.join(tempDir, 'tokens.json');
  });

  afterEach(() => {
    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe('getDefaultTokenPath', () => {
    it('returns path in user config directory', () => {
      const tokenPath = getDefaultTokenPath();
      expect(tokenPath).toContain('.config');
      expect(tokenPath).toContain('mcp-sheet-filler');
      expect(tokenPath).toContain('tokens.json');
    });
  });

  describe('saveTokens and loadTokens', () => {
    it('saves and loads tokens correctly', () => {
      const tokens: OAuthTokens = {
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        expiry_date: Date.now() + 3600000,
      };

      saveTokens(tokens, tempTokenPath);
      const loaded = loadTokens(tempTokenPath);

      expect(loaded).toEqual(tokens);
    });

    it('creates directory if it does not exist', () => {
      const nestedPath = path.join(tempDir, 'nested', 'dir', 'tokens.json');
      const tokens: OAuthTokens = {
        access_token: 'test-token',
      };

      saveTokens(tokens, nestedPath);

      expect(fs.existsSync(nestedPath)).toBe(true);
      const loaded = loadTokens(nestedPath);
      expect(loaded?.access_token).toBe('test-token');
    });

    it('returns null when token file does not exist', () => {
      const result = loadTokens('/nonexistent/path/tokens.json');
      expect(result).toBeNull();
    });

    it('returns null when token file is invalid JSON', () => {
      fs.writeFileSync(tempTokenPath, 'not valid json');
      const result = loadTokens(tempTokenPath);
      expect(result).toBeNull();
    });
  });

  describe('isTokenExpired', () => {
    it('returns false when no expiry_date', () => {
      const tokens: OAuthTokens = {
        access_token: 'test-token',
      };
      expect(isTokenExpired(tokens)).toBe(false);
    });

    it('returns false when token is not expired', () => {
      const tokens: OAuthTokens = {
        access_token: 'test-token',
        expiry_date: Date.now() + 3600000, // 1 hour from now
      };
      expect(isTokenExpired(tokens)).toBe(false);
    });

    it('returns true when token is expired', () => {
      const tokens: OAuthTokens = {
        access_token: 'test-token',
        expiry_date: Date.now() - 1000, // 1 second ago
      };
      expect(isTokenExpired(tokens)).toBe(true);
    });

    it('returns true when token expires within 5 minute buffer', () => {
      const tokens: OAuthTokens = {
        access_token: 'test-token',
        expiry_date: Date.now() + 2 * 60 * 1000, // 2 minutes from now (within 5 min buffer)
      };
      expect(isTokenExpired(tokens)).toBe(true);
    });

    it('returns false when token expires after 5 minute buffer', () => {
      const tokens: OAuthTokens = {
        access_token: 'test-token',
        expiry_date: Date.now() + 10 * 60 * 1000, // 10 minutes from now
      };
      expect(isTokenExpired(tokens)).toBe(false);
    });
  });
});
