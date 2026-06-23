import { Test, TestingModule } from '@nestjs/testing';
import { CallStatus } from '../database/entities/call-status.enum';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { CallState, CallStateStore } from './call-state.store';

/** Minimal pipeline mock returned by redis.pipeline(). */
function makePipelineMock() {
  const pipeline = {
    hset: jest.fn().mockReturnThis(),
    expire: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([]),
  };
  return pipeline;
}

describe('CallStateStore', () => {
  let store: CallStateStore;
  let redisMock: {
    pipeline: jest.Mock;
    hgetall: jest.Mock;
  };

  beforeEach(async () => {
    redisMock = {
      pipeline: jest.fn(),
      hgetall: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [CallStateStore, { provide: REDIS_CLIENT, useValue: redisMock }],
    }).compile();

    store = module.get<CallStateStore>(CallStateStore);
  });

  // ── write ────────────────────────────────────────────────────────────────────

  describe('write', () => {
    it('sends HSET with all fields and EXPIRE with the given TTL', async () => {
      const pipeline = makePipelineMock();
      redisMock.pipeline.mockReturnValue(pipeline);

      const state: CallState = {
        id: 'uuid-1',
        apiKeyId: 'key-1',
        from: '+15550001111',
        to: '+15550002222',
        status: CallStatus.QUEUED,
        metadata: { campaign: 'test' },
        recordingUrl: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };

      await store.write(state, 3600);

      // Pipeline must be opened.
      expect(redisMock.pipeline).toHaveBeenCalledTimes(1);

      // HSET should be called with the key and a field map.
      expect(pipeline.hset).toHaveBeenCalledWith(
        'call:uuid-1',
        expect.objectContaining({
          id: 'uuid-1',
          apiKeyId: 'key-1',
          from: '+15550001111',
          to: '+15550002222',
          status: CallStatus.QUEUED,
          // metadata serialised as JSON string
          metadata: JSON.stringify({ campaign: 'test' }),
          // null recordingUrl stored as empty string
          recordingUrl: '',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        }),
      );

      // EXPIRE should be set with the correct TTL.
      expect(pipeline.expire).toHaveBeenCalledWith('call:uuid-1', 3600);

      expect(pipeline.exec).toHaveBeenCalledTimes(1);
    });

    it('serialises null metadata as an empty string', async () => {
      const pipeline = makePipelineMock();
      redisMock.pipeline.mockReturnValue(pipeline);

      const state: CallState = {
        id: 'uuid-2',
        apiKeyId: 'key-1',
        from: '+1',
        to: '+2',
        status: CallStatus.QUEUED,
        metadata: null,
        recordingUrl: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };

      await store.write(state, 60);

      expect(pipeline.hset).toHaveBeenCalledWith(
        'call:uuid-2',
        expect.objectContaining({ metadata: '' }),
      );
    });

    it('stores a non-null recordingUrl as-is', async () => {
      const pipeline = makePipelineMock();
      redisMock.pipeline.mockReturnValue(pipeline);

      const state: CallState = {
        id: 'uuid-3',
        apiKeyId: 'key-1',
        from: '+1',
        to: '+2',
        status: CallStatus.COMPLETED,
        metadata: null,
        recordingUrl: 'https://s3.example.com/recording.mp3',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };

      await store.write(state, 60);

      expect(pipeline.hset).toHaveBeenCalledWith(
        'call:uuid-3',
        expect.objectContaining({ recordingUrl: 'https://s3.example.com/recording.mp3' }),
      );
    });

    it('throws when a pipelined command reports an error (Redis down)', async () => {
      const pipeline = makePipelineMock();
      // ioredis resolves exec() with [error, result] tuples instead of rejecting;
      // a failed HSET surfaces as an error in the first tuple.
      const redisErr = new Error('Connection is closed.');
      pipeline.exec.mockResolvedValue([
        [redisErr, null],
        [null, 1],
      ]);
      redisMock.pipeline.mockReturnValue(pipeline);

      const state: CallState = {
        id: 'uuid-4',
        apiKeyId: 'key-1',
        from: '+1',
        to: '+2',
        status: CallStatus.QUEUED,
        metadata: null,
        recordingUrl: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };

      await expect(store.write(state, 60)).rejects.toThrow('Connection is closed.');
    });
  });

  // ── read ─────────────────────────────────────────────────────────────────────

  describe('read', () => {
    it('returns null when hgetall returns an empty object (key missing)', async () => {
      redisMock.hgetall.mockResolvedValue({});

      const result = await store.read('nonexistent-id');
      expect(result).toBeNull();
    });

    it('deserialises a full hash including metadata JSON', async () => {
      redisMock.hgetall.mockResolvedValue({
        id: 'uuid-1',
        apiKeyId: 'key-1',
        from: '+15550001111',
        to: '+15550002222',
        status: 'QUEUED',
        metadata: JSON.stringify({ campaign: 'test' }),
        recordingUrl: '',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      });

      const result = await store.read('uuid-1');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('uuid-1');
      expect(result!.status).toBe(CallStatus.QUEUED);
      expect(result!.metadata).toEqual({ campaign: 'test' });
      // Empty recordingUrl string must be mapped to null.
      expect(result!.recordingUrl).toBeNull();
    });

    it('maps empty recordingUrl string to null', async () => {
      redisMock.hgetall.mockResolvedValue({
        id: 'uuid-1',
        apiKeyId: 'key-1',
        from: '+1',
        to: '+2',
        status: 'QUEUED',
        metadata: '',
        recordingUrl: '',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      });

      const result = await store.read('uuid-1');
      expect(result!.recordingUrl).toBeNull();
      expect(result!.metadata).toBeNull();
    });

    it('maps a non-empty recordingUrl to a string', async () => {
      redisMock.hgetall.mockResolvedValue({
        id: 'uuid-1',
        apiKeyId: 'key-1',
        from: '+1',
        to: '+2',
        status: 'COMPLETED',
        metadata: '',
        recordingUrl: 'https://s3.example.com/r.mp3',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      });

      const result = await store.read('uuid-1');
      expect(result!.recordingUrl).toBe('https://s3.example.com/r.mp3');
    });
  });
});
