import type { TokenValidationResult } from './types.js';
import { logger } from '../logger.js';

const GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

interface GoogleTokenInfo {
  aud: string;
  azp?: string;
  email?: string;
  sub?: string;
  email_verified?: string;
  expires_in?: string;
  scope?: string;
  error_description?: string;
}

interface GoogleUserInfo {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

/**
 * Fetch user info from Google's userinfo endpoint.
 * This is used as a fallback when tokeninfo doesn't include user identity.
 */
async function fetchUserInfo(accessToken: string): Promise<GoogleUserInfo | null> {
  try {
    const response = await fetch(GOOGLE_USERINFO_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      logger.debug('userinfo_fetch_failed', { status: response.status });
      return null;
    }

    const data = (await response.json()) as GoogleUserInfo;
    logger.debug('userinfo_fetched', { email: data.email, sub: data.sub });
    return data;
  } catch (error) {
    logger.debug('userinfo_fetch_error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
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
    let userId = data.email || data.sub;
    let email = data.email;

    // If tokeninfo doesn't include user identity, try userinfo endpoint
    // This happens when token was obtained without openid/email scopes
    if (!userId) {
      logger.debug('token_missing_identity_trying_userinfo', { azp: data.azp });
      const userInfo = await fetchUserInfo(accessToken);
      if (userInfo) {
        userId = userInfo.email || userInfo.sub;
        email = userInfo.email;
      }
    }

    if (!userId) {
      logger.debug('token_missing_user_id', { data });
      return {
        valid: false,
        error: 'Token does not contain user identifier. Ensure token includes openid or email scope.',
      };
    }

    logger.debug('token_validated', {
      email,
      userId,
    });

    return {
      valid: true,
      userId,
      email,
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
