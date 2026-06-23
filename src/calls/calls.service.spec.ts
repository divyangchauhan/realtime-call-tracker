import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { RequestApiKey } from '../auth/auth.types';
import { Call } from '../database/entities/call.entity';
import { CallStatus } from '../database/entities/call-status.enum';
import { CallStateStore } from './call-state.store';
import { CallsService } from './calls.service';
import { CreateCallDto } from './dto/create-call.dto';

// ── Shared fixtures ──────────────────────────────────────────────────────────

const MOCK_API_KEY: RequestApiKey = {
  id: 'api-key-id-1',
  name: 'test-key',
  maxConcurrent: 5,
  maxCps: 1,
};

const MOCK_CALL_ID = 'call-uuid-1234';

const BASE_DATE = new Date('2024-01-01T00:00:00.000Z');

const SAVED_CALL: Call = {
  id: MOCK_CALL_ID,
  apiKeyId: MOCK_API_KEY.id,
  fromNumber: '+15550001111',
  toNumber: '+15550002222',
  status: CallStatus.QUEUED,
  metadata: { campaign: 'x' },
  recordingUrl: null,
  completedAt: null,
  createdAt: BASE_DATE,
  updatedAt: BASE_DATE,
  apiKey: {} as never,
};

// ── Test suite ───────────────────────────────────────────────────────────────

describe('CallsService', () => {
  let service: CallsService;

  // Mock dependencies
  let repoMock: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
  };
  let stateStoreMock: {
    write: jest.Mock;
    read: jest.Mock;
  };

  beforeEach(async () => {
    repoMock = {
      create: jest.fn().mockReturnValue({ ...SAVED_CALL }),
      save: jest.fn().mockResolvedValue({ ...SAVED_CALL }),
      findOne: jest.fn(),
    };

    stateStoreMock = {
      write: jest.fn().mockResolvedValue(undefined),
      read: jest.fn().mockResolvedValue(null),
    };

    const configMock = {
      get: jest.fn().mockReturnValue({
        stateTtlSeconds: 3600,
        wsPublicUrl: 'ws://localhost:3000/ws',
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CallsService,
        { provide: getRepositoryToken(Call), useValue: repoMock },
        { provide: CallStateStore, useValue: stateStoreMock },
        { provide: ConfigService, useValue: configMock },
      ],
    }).compile();

    service = module.get<CallsService>(CallsService);
  });

  // ── createCall ───────────────────────────────────────────────────────────────

  describe('createCall', () => {
    const dto: CreateCallDto = {
      from: '+15550001111',
      to: '+15550002222',
      metadata: { campaign: 'x' },
    };

    it('saves a QUEUED row with correct fields', async () => {
      await service.createCall(MOCK_API_KEY, dto);

      expect(repoMock.create).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKeyId: MOCK_API_KEY.id,
          fromNumber: dto.from,
          toNumber: dto.to,
          status: CallStatus.QUEUED,
          metadata: { campaign: 'x' },
        }),
      );
      expect(repoMock.save).toHaveBeenCalledTimes(1);
    });

    it('writes Redis hash with TTL after saving', async () => {
      await service.createCall(MOCK_API_KEY, dto);

      expect(stateStoreMock.write).toHaveBeenCalledWith(
        expect.objectContaining({
          id: MOCK_CALL_ID,
          apiKeyId: MOCK_API_KEY.id,
          from: dto.from,
          to: dto.to,
          status: CallStatus.QUEUED,
          metadata: { campaign: 'x' },
        }),
        3600,
      );
    });

    it('returns { call_id, websocket_url } with the correct callId query param', async () => {
      const result = await service.createCall(MOCK_API_KEY, dto);

      expect(result.call_id).toBe(MOCK_CALL_ID);
      expect(result.websocket_url).toBe(`ws://localhost:3000/ws?callId=${MOCK_CALL_ID}`);
    });

    it('succeeds even when the Redis write rejects (best-effort)', async () => {
      stateStoreMock.write.mockRejectedValueOnce(new Error('Redis connection refused'));

      const result = await service.createCall(MOCK_API_KEY, dto);

      // Repo save must have been called — the Postgres write is durable.
      expect(repoMock.save).toHaveBeenCalledTimes(1);
      // The result should still be returned normally.
      expect(result.call_id).toBe(MOCK_CALL_ID);
    });
  });

  // ── getCall ──────────────────────────────────────────────────────────────────

  describe('getCall', () => {
    const redisState = {
      id: MOCK_CALL_ID,
      apiKeyId: MOCK_API_KEY.id,
      from: '+15550001111',
      to: '+15550002222',
      status: CallStatus.QUEUED,
      metadata: { campaign: 'x' },
      recordingUrl: null,
      createdAt: BASE_DATE.toISOString(),
      updatedAt: BASE_DATE.toISOString(),
    };

    it('returns the Redis state when present and does NOT hit the repo', async () => {
      stateStoreMock.read.mockResolvedValueOnce(redisState);

      const result = await service.getCall(MOCK_API_KEY, MOCK_CALL_ID);

      expect(result.id).toBe(MOCK_CALL_ID);
      expect(result.status).toBe(CallStatus.QUEUED);
      // Repo must NOT have been queried.
      expect(repoMock.findOne).not.toHaveBeenCalled();
    });

    it('falls back to the repo when Redis returns null', async () => {
      stateStoreMock.read.mockResolvedValueOnce(null);
      repoMock.findOne.mockResolvedValueOnce({ ...SAVED_CALL });

      const result = await service.getCall(MOCK_API_KEY, MOCK_CALL_ID);

      expect(result.id).toBe(MOCK_CALL_ID);
      expect(repoMock.findOne).toHaveBeenCalledWith({
        where: { id: MOCK_CALL_ID, apiKeyId: MOCK_API_KEY.id },
      });
    });

    it('throws NotFoundException when neither Redis nor Postgres has the call', async () => {
      stateStoreMock.read.mockResolvedValueOnce(null);
      repoMock.findOne.mockResolvedValueOnce(null);

      await expect(service.getCall(MOCK_API_KEY, MOCK_CALL_ID)).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when the Redis state belongs to a different API key', async () => {
      const foreignState = { ...redisState, apiKeyId: 'other-key-id' };
      stateStoreMock.read.mockResolvedValueOnce(foreignState);

      await expect(service.getCall(MOCK_API_KEY, MOCK_CALL_ID)).rejects.toThrow(NotFoundException);
      // Must not fall through to the repo.
      expect(repoMock.findOne).not.toHaveBeenCalled();
    });
  });
});
