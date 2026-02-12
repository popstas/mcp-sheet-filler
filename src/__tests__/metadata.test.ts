import { describe, it, expect } from 'vitest';
import { generateProtectedResourceMetadata, getMetadataUrl } from '../auth/metadata.js';
import type { AuthConfig } from '../auth/types.js';

function makeConfig(resourceUrl: string): AuthConfig {
  return { resourceUrl, clientId: 'test-client-id', clientSecret: 'test-secret' };
}

describe('generateProtectedResourceMetadata', () => {
  it('sets resource to resourceUrl + /mcp', () => {
    const metadata = generateProtectedResourceMetadata(makeConfig('https://example.com'));
    expect(metadata.resource).toBe('https://example.com/mcp');
  });

  it('strips trailing slash before appending /mcp', () => {
    const metadata = generateProtectedResourceMetadata(makeConfig('https://example.com/'));
    expect(metadata.resource).toBe('https://example.com/mcp');
  });

  it('strips multiple trailing slashes', () => {
    const metadata = generateProtectedResourceMetadata(makeConfig('https://example.com///'));
    expect(metadata.resource).toBe('https://example.com/mcp');
  });

  it('sets authorization_servers to base URL without trailing slash', () => {
    const metadata = generateProtectedResourceMetadata(makeConfig('https://example.com/'));
    expect(metadata.authorization_servers).toEqual(['https://example.com']);
  });

  it('includes required fields', () => {
    const metadata = generateProtectedResourceMetadata(makeConfig('https://example.com'));
    expect(metadata.bearer_methods_supported).toEqual(['header']);
    expect(metadata.scopes_supported).toContain('https://www.googleapis.com/auth/spreadsheets');
  });
});

describe('getMetadataUrl', () => {
  it('returns path-based well-known URL with /mcp suffix', () => {
    expect(getMetadataUrl('https://example.com')).toBe(
      'https://example.com/.well-known/oauth-protected-resource/mcp'
    );
  });

  it('strips trailing slash', () => {
    expect(getMetadataUrl('https://example.com/')).toBe(
      'https://example.com/.well-known/oauth-protected-resource/mcp'
    );
  });
});
