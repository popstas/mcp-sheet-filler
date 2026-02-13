import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request, Response } from 'express';
import { authenticateRequest } from '../transport/http.js';
import type { AuthConfig } from '../auth/types.js';

// Mock token-validator so we don't make real HTTP calls
vi.mock('../auth/token-validator.js', () => ({
  validateGoogleToken: vi.fn(),
}));

import { validateGoogleToken } from '../auth/token-validator.js';

const mockAuthConfig: AuthConfig = {
  resourceUrl: 'https://example.com',
  clientId: 'google-client-id',
  clientSecret: 'google-client-secret',
};

/**
 * Helper: create a minimal mock Express Request.
 */
function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    method: 'GET',
    url: '/mcp',
    ...overrides,
  } as unknown as Request;
}

/**
 * Helper: create a minimal mock Express Response that captures status/json/setHeader calls.
 */
function mockRes() {
  const res: Partial<Response> & { _status?: number; _body?: unknown; _headers: Record<string, string> } = {
    _headers: {},
    setHeader(name: string, value: string) {
      res._headers[name] = value;
      return res as Response;
    },
    status(code: number) {
      res._status = code;
      return res as Response;
    },
    json(body: unknown) {
      res._body = body;
      return res as Response;
    },
  };
  return res as Response & { _status?: number; _body?: unknown; _headers: Record<string, string> };
}

describe('authenticateRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when no Authorization header and no session auth', async () => {
    const req = mockReq();
    const res = mockRes();

    const result = await authenticateRequest(req, res, mockAuthConfig);

    expect(result).toBeNull();
    expect(res._status).toBe(401);
    expect(res._body).toMatchObject({ error: 'unauthorized' });
  });

  it('falls back to session auth when Authorization header is missing', async () => {
    const req = mockReq();
    const res = mockRes();
    const sessionAuth = { userId: 'user-123', email: 'user@test.com', accessToken: 'cached-token' };

    const result = await authenticateRequest(req, res, mockAuthConfig, sessionAuth);

    expect(result).toEqual(sessionAuth);
    expect(res._status).toBeUndefined(); // no 401 sent
  });

  it('does NOT fall back to session auth when Authorization header is present but invalid', async () => {
    const req = mockReq({ headers: { authorization: 'Bearer bad-token' } });
    const res = mockRes();
    const sessionAuth = { userId: 'user-123', email: 'user@test.com', accessToken: 'cached-token' };

    (validateGoogleToken as any).mockResolvedValueOnce({ valid: false, error: 'invalid_token' });

    const result = await authenticateRequest(req, res, mockAuthConfig, sessionAuth);

    expect(result).toBeNull();
    expect(res._status).toBe(401);
  });

  it('returns 401 for non-Bearer authorization header', async () => {
    const req = mockReq({ headers: { authorization: 'Basic abc123' } });
    const res = mockRes();

    const result = await authenticateRequest(req, res, mockAuthConfig);

    expect(result).toBeNull();
    expect(res._status).toBe(401);
  });

  it('returns 401 for empty Bearer token', async () => {
    const req = mockReq({ headers: { authorization: 'Bearer ' } });
    const res = mockRes();

    const result = await authenticateRequest(req, res, mockAuthConfig);

    expect(result).toBeNull();
    expect(res._status).toBe(401);
  });

  it('validates token and returns auth info on success', async () => {
    const req = mockReq({ headers: { authorization: 'Bearer valid-token' } });
    const res = mockRes();

    (validateGoogleToken as any).mockResolvedValueOnce({
      valid: true,
      userId: 'user-456',
      email: 'user@test.com',
    });

    const result = await authenticateRequest(req, res, mockAuthConfig);

    expect(result).toEqual({
      userId: 'user-456',
      email: 'user@test.com',
      accessToken: 'valid-token',
    });
    expect(res._status).toBeUndefined();
  });

  it('does not use session auth fallback for malformed Bearer header', async () => {
    const req = mockReq({ headers: { authorization: 'Bearer ' } });
    const res = mockRes();
    const sessionAuth = { userId: 'user-123', email: 'user@test.com', accessToken: 'cached-token' };

    const result = await authenticateRequest(req, res, mockAuthConfig, sessionAuth);

    // Empty token = explicitly bad auth, no fallback
    expect(result).toBeNull();
    expect(res._status).toBe(401);
  });
});
