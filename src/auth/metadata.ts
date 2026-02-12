import type { ProtectedResourceMetadata, AuthConfig } from './types.js';

/** Google's OAuth 2.0 authorization server */
export const GOOGLE_AUTHORIZATION_SERVER = 'https://accounts.google.com';

/**
 * Generate RFC 9728 Protected Resource Metadata document.
 * @see https://datatracker.ietf.org/doc/html/rfc9728
 */
export function generateProtectedResourceMetadata(config: AuthConfig): ProtectedResourceMetadata {
  const baseUrl = config.resourceUrl.replace(/\/+$/, '');
  return {
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ['header'],
    scopes_supported: [
      'openid',
      'email',
      'https://www.googleapis.com/auth/spreadsheets',
    ],
  };
}

/**
 * Get the URL for the Protected Resource Metadata endpoint.
 */
export function getMetadataUrl(resourceUrl: string): string {
  // Ensure no trailing slash before appending path
  const baseUrl = resourceUrl.replace(/\/+$/, '');
  return `${baseUrl}/.well-known/oauth-protected-resource/mcp`;
}
