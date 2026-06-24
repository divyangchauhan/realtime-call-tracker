/**
 * Unit tests for MetricsService.
 *
 * Strategy:
 *  - The Call repository is mocked with a chainable createQueryBuilder() mock
 *    (select/addSelect/where/groupBy return `this`, getRawMany() resolves the
 *    fixture rows) plus a separate `count` mock for the with-recording read.
 *  - The Redis client is mocked with a `scard` jest.fn().
 */

import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { RequestApiKey } from '../auth/auth.types';
import { Call } from '../database/entities/call.entity';
import { CallStatus } from '../database/entities/call-status.enum';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { MetricsService } from './metrics.service';

// Fixtures

const MOCK_API_KEY: RequestApiKey = {
  id: 'api-key-id-1',
  name: 'test-key',
  maxConcurrent: 5,
  maxCps: 2,
};

/** Chainable query-builder mock matching the repo's createQueryBuilder() shape. */
function makeQueryBuilderMock() {
  const qb = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
  };
  return qb;
}

describe('MetricsService', () => {
  let service: MetricsService;
  let repoMock: { createQueryBuilder: jest.Mock; count: jest.Mock };
  let qbMock: ReturnType<typeof makeQueryBuilderMock>;
  let redisMock: { scard: jest.Mock };

  beforeEach(async () => {
    qbMock = makeQueryBuilderMock();
    repoMock = {
      createQueryBuilder: jest.fn().mockReturnValue(qbMock),
      count: jest.fn().mockResolvedValue(0),
    };

    redisMock = {
      scard: jest.fn().mockResolvedValue(0),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MetricsService,
        { provide: getRepositoryToken(Call), useValue: repoMock },
        { provide: REDIS_CLIENT, useValue: redisMock },
      ],
    }).compile();

    service = module.get<MetricsService>(MetricsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // calls.by_status / calls.total

  describe('calls.by_status', () => {
    it('zero-fills every CallStatus and parses Postgres bigint strings to numbers', async () => {
      qbMock.getRawMany.mockResolvedValue([
        { status: CallStatus.RINGING, count: '3' },
        { status: CallStatus.COMPLETED, count: '7' },
      ]);

      const result = await service.getMetrics(MOCK_API_KEY);

      expect(result.calls.by_status).toEqual({
        [CallStatus.QUEUED]: 0,
        [CallStatus.RINGING]: 3,
        [CallStatus.ANSWERED]: 0,
        [CallStatus.UNANSWERED]: 0,
        [CallStatus.COMPLETED]: 7,
      });
    });

    it('computes total as the sum of all status counts', async () => {
      qbMock.getRawMany.mockResolvedValue([
        { status: CallStatus.RINGING, count: '3' },
        { status: CallStatus.COMPLETED, count: '7' },
      ]);

      const result = await service.getMetrics(MOCK_API_KEY);

      expect(result.calls.total).toBe(10);
    });

    it('returns all-zero counts and a total of 0 when the key has no calls', async () => {
      qbMock.getRawMany.mockResolvedValue([]);

      const result = await service.getMetrics(MOCK_API_KEY);

      expect(result.calls.total).toBe(0);
      expect(Object.values(result.calls.by_status).every((c) => c === 0)).toBe(true);
    });

    it('scopes the query to the caller api key id', async () => {
      await service.getMetrics(MOCK_API_KEY);

      expect(qbMock.where).toHaveBeenCalledWith('call.api_key_id = :apiKeyId', {
        apiKeyId: MOCK_API_KEY.id,
      });
    });
  });

  // calls.with_recording

  describe('calls.with_recording', () => {
    it('is read from repo.count', async () => {
      repoMock.count.mockResolvedValue(4);

      const result = await service.getMetrics(MOCK_API_KEY);

      expect(result.calls.with_recording).toBe(4);
      expect(repoMock.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ apiKeyId: MOCK_API_KEY.id }),
        }),
      );
    });
  });

  // live.active_calls

  describe('live.active_calls', () => {
    it('comes from redis.scard against the active_calls:{apiKeyId} key', async () => {
      redisMock.scard.mockResolvedValue(2);

      const result = await service.getMetrics(MOCK_API_KEY);

      expect(result.live.active_calls).toBe(2);
      expect(redisMock.scard).toHaveBeenCalledWith(`active_calls:${MOCK_API_KEY.id}`);
    });

    it('degrades to 0 and does not throw when Redis scard rejects', async () => {
      redisMock.scard.mockRejectedValue(new Error('Redis connection refused'));

      const result = await service.getMetrics(MOCK_API_KEY);

      expect(result.live.active_calls).toBe(0);
    });
  });

  // limits

  describe('limits', () => {
    it('mirrors the passed RequestApiKey limits', async () => {
      const result = await service.getMetrics(MOCK_API_KEY);

      expect(result.limits).toEqual({
        max_concurrent: MOCK_API_KEY.maxConcurrent,
        max_cps: MOCK_API_KEY.maxCps,
      });
    });
  });

  // top-level shape

  describe('top-level shape', () => {
    it('echoes the caller api_key_id and includes an ISO generated_at timestamp', async () => {
      const result = await service.getMetrics(MOCK_API_KEY);

      expect(result.api_key_id).toBe(MOCK_API_KEY.id);
      expect(new Date(result.generated_at).toISOString()).toBe(result.generated_at);
    });
  });
});
