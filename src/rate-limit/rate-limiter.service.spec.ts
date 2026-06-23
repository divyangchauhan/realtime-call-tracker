import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { RateLimiterService } from './rate-limiter.service';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const API_KEY_ID = 'test-api-key-id';
const CALL_ID = 'test-call-uuid-1234';
const MAX_CONCURRENT = 3;
const MAX_CPS = 2;
const SET_TTL_SECONDS = 3600;

// ── Test suite ────────────────────────────────────────────────────────────────

describe('RateLimiterService', () => {
  let service: RateLimiterService;

  /** Controls the value returned by the mocked rateLimitAcquire command. */
  let rateLimitAcquireMock: jest.Mock;
  /** The mock Redis client passed to the service. */
  let redisMock: { defineCommand: jest.Mock; rateLimitAcquire: jest.Mock; srem: jest.Mock };

  beforeEach(async () => {
    rateLimitAcquireMock = jest.fn();

    // The mock needs defineCommand (onModuleInit), the dynamically-registered
    // rateLimitAcquire (acquire()), and srem (release()).
    redisMock = {
      defineCommand: jest.fn(), // no-op: we won't actually evaluate Lua in unit tests
      rateLimitAcquire: rateLimitAcquireMock,
      srem: jest.fn().mockResolvedValue(1),
    };

    const configMock = {
      get: jest.fn().mockReturnValue({ stateTtlSeconds: SET_TTL_SECONDS }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RateLimiterService,
        { provide: REDIS_CLIENT, useValue: redisMock },
        { provide: ConfigService, useValue: configMock },
      ],
    }).compile();

    service = module.get<RateLimiterService>(RateLimiterService);

    // Trigger OnModuleInit manually (Test.createTestingModule does not call lifecycle hooks).
    service.onModuleInit();
  });

  // ── onModuleInit ──────────────────────────────────────────────────────────

  describe('onModuleInit', () => {
    it('registers the rateLimitAcquire command on the Redis client', () => {
      expect(redisMock.defineCommand).toHaveBeenCalledWith(
        'rateLimitAcquire',
        expect.objectContaining({ numberOfKeys: 2 }),
      );
    });
  });

  // ── acquire — allowed ─────────────────────────────────────────────────────

  describe('acquire — allowed [1, "OK"]', () => {
    beforeEach(() => {
      rateLimitAcquireMock.mockResolvedValue([1, 'OK']);
    });

    it('returns { allowed: true, reason: "OK" }', async () => {
      const result = await service.acquire(API_KEY_ID, CALL_ID, MAX_CONCURRENT, MAX_CPS);
      expect(result).toEqual({ allowed: true, reason: 'OK' });
    });

    it('passes the correct SET key (active_calls:{apiKeyId}) as first key arg', async () => {
      await service.acquire(API_KEY_ID, CALL_ID, MAX_CONCURRENT, MAX_CPS);
      expect(rateLimitAcquireMock).toHaveBeenCalledWith(
        `active_calls:${API_KEY_ID}`, // KEYS[1]
        expect.any(String), // KEYS[2] — cpsKey
        expect.any(Number), // ARGV[1] — maxConcurrent
        expect.any(Number), // ARGV[2] — maxCps
        expect.any(Number), // ARGV[3] — nowMs
        expect.any(Number), // ARGV[4] — windowMs
        CALL_ID, // ARGV[5] — callId
        SET_TTL_SECONDS, // ARGV[6] — setTtlSeconds
      );
    });

    it('passes the correct ZSET key (cps:{apiKeyId}) as second key arg', async () => {
      await service.acquire(API_KEY_ID, CALL_ID, MAX_CONCURRENT, MAX_CPS);
      expect(rateLimitAcquireMock).toHaveBeenCalledWith(
        expect.any(String), // KEYS[1] — activeKey
        `cps:${API_KEY_ID}`, // KEYS[2]
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
        expect.any(String),
        expect.any(Number),
      );
    });

    it('passes maxConcurrent and maxCps in the correct arg positions', async () => {
      await service.acquire(API_KEY_ID, CALL_ID, MAX_CONCURRENT, MAX_CPS);
      const [, , argMaxConcurrent, argMaxCps] = rateLimitAcquireMock.mock.calls[0] as [
        string,
        string,
        number,
        number,
        ...unknown[],
      ];
      expect(argMaxConcurrent).toBe(MAX_CONCURRENT);
      expect(argMaxCps).toBe(MAX_CPS);
    });

    it('passes windowMs = 1000 (fixed rolling window)', async () => {
      await service.acquire(API_KEY_ID, CALL_ID, MAX_CONCURRENT, MAX_CPS);
      const [, , , , , windowMs] = rateLimitAcquireMock.mock.calls[0] as [
        string,
        string,
        number,
        number,
        number,
        number,
        ...unknown[],
      ];
      expect(windowMs).toBe(1000);
    });
  });

  // ── acquire — denied CPS ──────────────────────────────────────────────────

  describe('acquire — denied [0, "CPS"]', () => {
    beforeEach(() => {
      rateLimitAcquireMock.mockResolvedValue([0, 'CPS']);
    });

    it('returns { allowed: false, reason: "CPS" }', async () => {
      const result = await service.acquire(API_KEY_ID, CALL_ID, MAX_CONCURRENT, MAX_CPS);
      expect(result).toEqual({ allowed: false, reason: 'CPS' });
    });
  });

  // ── acquire — denied CONCURRENCY ─────────────────────────────────────────

  describe('acquire — denied [0, "CONCURRENCY"]', () => {
    beforeEach(() => {
      rateLimitAcquireMock.mockResolvedValue([0, 'CONCURRENCY']);
    });

    it('returns { allowed: false, reason: "CONCURRENCY" }', async () => {
      const result = await service.acquire(API_KEY_ID, CALL_ID, MAX_CONCURRENT, MAX_CPS);
      expect(result).toEqual({ allowed: false, reason: 'CONCURRENCY' });
    });
  });

  // ── acquire — fail-open on Redis error ────────────────────────────────────

  describe('acquire — fail-open when Redis throws', () => {
    beforeEach(() => {
      rateLimitAcquireMock.mockRejectedValue(new Error('Redis connection timeout'));
    });

    it('returns { allowed: true, reason: "OK" } instead of propagating the error', async () => {
      const result = await service.acquire(API_KEY_ID, CALL_ID, MAX_CONCURRENT, MAX_CPS);
      expect(result).toEqual({ allowed: true, reason: 'OK' });
    });

    it('does NOT rethrow the Redis error', async () => {
      await expect(
        service.acquire(API_KEY_ID, CALL_ID, MAX_CONCURRENT, MAX_CPS),
      ).resolves.not.toThrow();
    });
  });

  // ── release ───────────────────────────────────────────────────────────────

  describe('release', () => {
    it('removes the call ID from the active-calls SET', async () => {
      await service.release(API_KEY_ID, CALL_ID);
      expect(redisMock.srem).toHaveBeenCalledWith(`active_calls:${API_KEY_ID}`, CALL_ID);
    });

    it('swallows Redis errors (best-effort) instead of propagating', async () => {
      redisMock.srem.mockRejectedValueOnce(new Error('Redis down'));
      await expect(service.release(API_KEY_ID, CALL_ID)).resolves.toBeUndefined();
    });
  });
});
