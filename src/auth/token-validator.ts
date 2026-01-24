import type { TokenValidationResult } from './types.js';
import { logger } from '../logger.js';

const GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';

interface GoogleTokenInfo {
  aud: string;
  email?: string;
  sub?: string;
  email_verified?: string;
  expires_in?: string;
  scope?: string;
  error_description?: string;
}

/**
 * Validate a Google OAuth access token.
 * Validates the token with Google's tokeninfo endpoint and checks audience.
 *
 * @param accessToken - The access token to validate
 * @param expectedClientId - The Google OAuth client ID to validate against (audience)
 * @returns TokenValidationResult with validity status and user info or error
 */
export async function validateGoogleToken(
  accessToken: string,
  expectedClientId: string
): Promise<TokenValidationResult> {
  try {
    const response = await fetch(
      `${GOOGLE_TOKENINFO_URL}?access_token=${encodeURIComponent(accessToken)}`
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as Partial<GoogleTokenInfo>;
      logger.debug('token_validation_failed', {
        status: response.status,
        error: errorData.error_description,
      });
      return {
        valid: false,
        error: errorData.error_description || 'Invalid token',
      };
    }

    const data = (await response.json()) as GoogleTokenInfo;

    // Validate audience matches our client ID
    if (data.aud !== expectedClientId) {
      logger.debug('token_audience_mismatch', {
        expected: expectedClientId,
        actual: data.aud,
      });
      return {
        valid: false,
        error: 'Token not issued for this resource',
      };
    }

    // Extract user identifier (prefer email, fall back to sub)
    const userId = data.email || data.sub;
    if (!userId) {
      logger.debug('token_missing_user_id', { data });
      return {
        valid: false,
        error: 'Token does not contain user identifier',
      };
    }

    logger.debug('token_validated', {
      email: data.email,
      sub: data.sub,
    });

    return {
      valid: true,
      userId,
      email: data.email,
    };
  } catch (error) {
    logger.error('token_validation_error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      valid: false,
      error: 'Token validation failed',
    };
  }
}
