import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeyAuthGuard } from './api-key-auth.guard';
import { IS_PUBLIC_KEY } from './public.decorator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a minimal fake ExecutionContext for unit tests. */
function buildContext(authHeader: string | undefined, isPublic: boolean = false): ExecutionContext {
  const request: Record<string, unknown> = {
    headers: authHeader !== undefined ? { authorization: authHeader } : {},
  };

  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => request,
    }),
    // Additional required ExecutionContext methods (unused by the guard)
    getArgs: () => [],
    getArgByIndex: () => undefined,
    switchToRpc: () => ({}),
    switchToWs: () => ({}),
    getType: () => 'http',
    _isPublic: isPublic,
    _request: request,
  } as unknown as ExecutionContext;
}

/** A minimal ApiKey-like row returned by the mock repository. */
const ACTIVE_KEY_ROW = {
  id: 'uuid-1',
  name: 'test-key',
  keyHash: 'will-be-ignored-in-unit-test',
  maxConcurrent: 5,
  maxCps: 10,
  isActive: true,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ApiKeyAuthGuard', () => {
  let guard: ApiKeyAuthGuard;
  let reflector: jest.Mocked<Reflector>;
  let findOne: jest.Mock;

  beforeEach(() => {
    findOne = jest.fn();

    reflector = {
      getAllAndOverride: jest.fn(),
    } as unknown as jest.Mocked<Reflector>;

    guard = new ApiKeyAuthGuard(reflector, { findOne } as any);
  });

  // ── Public routes ──────────────────────────────────────────────────────────

  describe('when the route is marked @Public()', () => {
    beforeEach(() => {
      // Simulate reflector finding IS_PUBLIC_KEY = true on handler or class.
      reflector.getAllAndOverride.mockImplementation((key) => {
        return key === IS_PUBLIC_KEY ? true : undefined;
      });
    });

    it('returns true without calling the repository', async () => {
      const ctx = buildContext(undefined);
      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      expect(findOne).not.toHaveBeenCalled();
    });
  });

  // ── Missing / malformed header ─────────────────────────────────────────────

  describe('when the route is NOT public', () => {
    beforeEach(() => {
      // Non-public route: reflector returns undefined/false for IS_PUBLIC_KEY.
      reflector.getAllAndOverride.mockReturnValue(undefined);
    });

    it('throws UnauthorizedException when the Authorization header is absent', async () => {
      const ctx = buildContext(undefined);

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        new UnauthorizedException('Missing or malformed Authorization header'),
      );
    });

    it('throws UnauthorizedException when the scheme is not Bearer', async () => {
      const ctx = buildContext('Basic dXNlcjpwYXNz');

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        new UnauthorizedException('Missing or malformed Authorization header'),
      );
    });

    it('throws UnauthorizedException when the header is "Bearer" with no token', async () => {
      const ctx = buildContext('Bearer');

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        new UnauthorizedException('Missing or malformed Authorization header'),
      );
    });

    it('throws UnauthorizedException when the header has extra parts', async () => {
      const ctx = buildContext('Bearer token extra');

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        new UnauthorizedException('Missing or malformed Authorization header'),
      );
    });

    // ── Repository look-up failures ──────────────────────────────────────────

    it('throws UnauthorizedException (generic) when the key is not found', async () => {
      findOne.mockResolvedValue(null);
      const ctx = buildContext('Bearer unknown-key');

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        new UnauthorizedException('Invalid API key'),
      );
    });

    it('throws UnauthorizedException (generic) when the key exists but is inactive (repo returns null due to isActive filter)', async () => {
      // The guard queries with isActive: true — inactive keys are never returned.
      findOne.mockResolvedValue(null);
      const ctx = buildContext('Bearer inactive-key');

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        new UnauthorizedException('Invalid API key'),
      );
    });

    // ── Successful authentication ────────────────────────────────────────────

    it('returns true and attaches apiKey to the request for a valid active key', async () => {
      findOne.mockResolvedValue(ACTIVE_KEY_ROW);

      const request: Record<string, unknown> = {
        headers: { authorization: 'Bearer good-key' },
      };
      const ctx = {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({ getRequest: () => request }),
        getArgs: () => [],
        getArgByIndex: () => undefined,
        switchToRpc: () => ({}),
        switchToWs: () => ({}),
        getType: () => 'http',
      } as unknown as ExecutionContext;

      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      expect(request['apiKey']).toEqual({
        id: ACTIVE_KEY_ROW.id,
        name: ACTIVE_KEY_ROW.name,
        maxConcurrent: ACTIVE_KEY_ROW.maxConcurrent,
        maxCps: ACTIVE_KEY_ROW.maxCps,
      });
    });

    it('passes the hashed token (not the raw token) to findOne', async () => {
      findOne.mockResolvedValue(ACTIVE_KEY_ROW);
      const ctx = buildContext('Bearer raw-token');

      await guard.canActivate(ctx);

      // The guard must never query by raw key — only by its SHA-256 hash.
      const callArg = findOne.mock.calls[0][0];
      expect(callArg.where.keyHash).not.toBe('raw-token');
      expect(callArg.where.keyHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('queries only active keys (isActive: true in the where clause)', async () => {
      findOne.mockResolvedValue(ACTIVE_KEY_ROW);
      const ctx = buildContext('Bearer any-key');

      await guard.canActivate(ctx);

      expect(findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ isActive: true }) }),
      );
    });

    it('accepts a Bearer scheme in mixed case (case-insensitive)', async () => {
      findOne.mockResolvedValue(ACTIVE_KEY_ROW);
      const ctx = buildContext('BEARER good-key');

      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
    });
  });
});
