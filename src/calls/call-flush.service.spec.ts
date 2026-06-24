/**
 * Unit tests for CallFlushService.
 *
 * Strategy:
 *  - CallStateStore is mocked ({ readDirtyIds, read, clearDirty }).
 *  - The Call repository is mocked with a chainable createQueryBuilder() mock
 *    whose update/set/where/andWhere all return `this` and execute() resolves.
 *  - jest.useFakeTimers() controls onModuleInit's setInterval so we can assert
 *    the timer lifecycle without real delays.
 */

import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { Call } from '../database/entities/call.entity';
import { CallStatus } from '../database/entities/call-status.enum';
import { CallFlushService } from './call-flush.service';
import { CallState, CallStateStore } from './call-state.store';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeCallState(overrides: Partial<CallState> = {}): CallState {
  return {
    id: 'call-uuid-test',
    apiKeyId: 'api-key-1',
    from: '+15550001111',
    to: '+15550002222',
    status: CallStatus.RINGING,
    metadata: null,
    recordingUrl: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:01.000Z',
    ...overrides,
  };
}

/** Chainable query-builder mock matching the repo's createQueryBuilder() shape. */
function makeQueryBuilderMock() {
  const qb = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  return qb;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('CallFlushService', () => {
  let service: CallFlushService;
  let stateStoreMock: {
    readDirtyIds: jest.Mock;
    read: jest.Mock;
    clearDirty: jest.Mock;
  };
  let repoMock: { createQueryBuilder: jest.Mock };
  let qbMock: ReturnType<typeof makeQueryBuilderMock>;
  let configMock: { get: jest.Mock };

  beforeEach(async () => {
    stateStoreMock = {
      readDirtyIds: jest.fn().mockResolvedValue([]),
      read: jest.fn(),
      clearDirty: jest.fn().mockResolvedValue(undefined),
    };

    qbMock = makeQueryBuilderMock();
    repoMock = { createQueryBuilder: jest.fn().mockReturnValue(qbMock) };

    configMock = {
      get: jest.fn().mockReturnValue({ intervalMs: 5000 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CallFlushService,
        { provide: CallStateStore, useValue: stateStoreMock },
        { provide: getRepositoryToken(Call), useValue: repoMock },
        { provide: ConfigService, useValue: configMock },
      ],
    }).compile();

    service = module.get<CallFlushService>(CallFlushService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  describe('happy path', () => {
    it('reads each dirty id, updates Postgres with the COMPLETED guard, and clears dirty', async () => {
      stateStoreMock.readDirtyIds.mockResolvedValue(['id-1', 'id-2']);
      stateStoreMock.read.mockImplementation((id: string) =>
        Promise.resolve(makeCallState({ id, status: CallStatus.RINGING })),
      );

      await service.flush();

      expect(stateStoreMock.readDirtyIds).toHaveBeenCalledTimes(1);
      expect(stateStoreMock.read).toHaveBeenCalledWith('id-1');
      expect(stateStoreMock.read).toHaveBeenCalledWith('id-2');

      expect(repoMock.createQueryBuilder).toHaveBeenCalledTimes(2);
      expect(qbMock.update).toHaveBeenCalledWith(Call);
      expect(qbMock.set).toHaveBeenCalledWith({ status: CallStatus.RINGING });
      expect(qbMock.where).toHaveBeenCalledWith('id = :id', { id: 'id-1' });
      expect(qbMock.andWhere).toHaveBeenCalledWith('status != :completed', {
        completed: CallStatus.COMPLETED,
      });
      expect(qbMock.execute).toHaveBeenCalledTimes(2);

      expect(stateStoreMock.clearDirty).toHaveBeenCalledWith('id-1');
      expect(stateStoreMock.clearDirty).toHaveBeenCalledWith('id-2');
      expect(stateStoreMock.clearDirty).toHaveBeenCalledTimes(2);
    });

    it('does nothing when there are no dirty ids', async () => {
      stateStoreMock.readDirtyIds.mockResolvedValue([]);

      await service.flush();

      expect(stateStoreMock.read).not.toHaveBeenCalled();
      expect(repoMock.createQueryBuilder).not.toHaveBeenCalled();
      expect(stateStoreMock.clearDirty).not.toHaveBeenCalled();
    });
  });

  // ── COMPLETED guard no-op (UPDATE affected 0 rows) ─────────────────────────

  describe('when the guarded UPDATE matches no row (already COMPLETED)', () => {
    it('still clears the dirty marker — a 0-row guarded no-op is not a failure', async () => {
      // The whole point of `AND status != COMPLETED`: if the call already raced
      // ahead to a durable COMPLETED write-through, the UPDATE affects 0 rows.
      // That is the expected, successful no-op — the id is reconciled (terminal)
      // and MUST be cleared, otherwise it would leak in calls:dirty forever.
      stateStoreMock.readDirtyIds.mockResolvedValue(['done-id']);
      stateStoreMock.read.mockResolvedValue(makeCallState({ id: 'done-id' }));
      qbMock.execute.mockResolvedValue({ affected: 0 });

      await service.flush();

      expect(qbMock.execute).toHaveBeenCalledTimes(1);
      expect(stateStoreMock.clearDirty).toHaveBeenCalledWith('done-id');
      expect(stateStoreMock.clearDirty).toHaveBeenCalledTimes(1);
    });
  });

  // ── Missing Redis state ────────────────────────────────────────────────────

  describe('when the Redis hash has expired', () => {
    it('clears the dirty marker without issuing an UPDATE', async () => {
      stateStoreMock.readDirtyIds.mockResolvedValue(['gone-id']);
      stateStoreMock.read.mockResolvedValue(null);

      await service.flush();

      expect(repoMock.createQueryBuilder).not.toHaveBeenCalled();
      expect(stateStoreMock.clearDirty).toHaveBeenCalledWith('gone-id');
      expect(stateStoreMock.clearDirty).toHaveBeenCalledTimes(1);
    });
  });

  // ── Per-id DB failure ──────────────────────────────────────────────────────

  describe('when the DB update fails for one id', () => {
    it('leaves the failing id dirty but still processes the others, and does not throw', async () => {
      stateStoreMock.readDirtyIds.mockResolvedValue(['bad-id', 'good-id']);
      stateStoreMock.read.mockImplementation((id: string) =>
        Promise.resolve(makeCallState({ id, status: CallStatus.ANSWERED })),
      );

      qbMock.execute
        .mockRejectedValueOnce(new Error('DB connection lost'))
        .mockResolvedValueOnce({ affected: 1 });

      await expect(service.flush()).resolves.not.toThrow();

      // The failing id must NOT be cleared (left for retry).
      expect(stateStoreMock.clearDirty).not.toHaveBeenCalledWith('bad-id');
      // The other id should still have been processed and cleared.
      expect(stateStoreMock.clearDirty).toHaveBeenCalledWith('good-id');
      expect(stateStoreMock.clearDirty).toHaveBeenCalledTimes(1);
    });
  });

  // ── readDirtyIds failure ───────────────────────────────────────────────────

  describe('when readDirtyIds rejects', () => {
    it('swallows the error and resets the running guard', async () => {
      stateStoreMock.readDirtyIds.mockRejectedValueOnce(new Error('Redis SMEMBERS failed'));

      await expect(service.flush()).resolves.not.toThrow();

      expect(stateStoreMock.read).not.toHaveBeenCalled();

      // The guard must have been reset so a subsequent flush can proceed normally.
      stateStoreMock.readDirtyIds.mockResolvedValue(['id-1']);
      stateStoreMock.read.mockResolvedValue(makeCallState({ id: 'id-1' }));

      await service.flush();

      expect(stateStoreMock.clearDirty).toHaveBeenCalledWith('id-1');
    });
  });

  // ── Re-entrancy guard ──────────────────────────────────────────────────────

  describe('re-entrancy guard', () => {
    it('skips a second flush() invoked while the first is still in-flight', async () => {
      let resolveReadDirtyIds!: (ids: string[]) => void;
      stateStoreMock.readDirtyIds.mockReturnValue(
        new Promise<string[]>((resolve) => {
          resolveReadDirtyIds = resolve;
        }),
      );

      const firstFlush = service.flush();
      // The first call has set `running = true` synchronously by this point
      // (flush() sets it before awaiting anything asynchronous below it).
      const secondFlush = service.flush();

      // Let the first flush's pending readDirtyIds() resolve with no ids.
      resolveReadDirtyIds([]);

      await Promise.all([firstFlush, secondFlush]);

      // readDirtyIds must only have been called once — the second invocation
      // returned immediately without doing any work.
      expect(stateStoreMock.readDirtyIds).toHaveBeenCalledTimes(1);
    });

    it('allows a subsequent flush() after the previous one has completed', async () => {
      stateStoreMock.readDirtyIds.mockResolvedValue([]);

      await service.flush();
      await service.flush();

      expect(stateStoreMock.readDirtyIds).toHaveBeenCalledTimes(2);
    });
  });

  // ── Timer lifecycle ────────────────────────────────────────────────────────

  describe('timer lifecycle', () => {
    it('starts an interval on onModuleInit and clears it on onModuleDestroy', () => {
      jest.useFakeTimers();
      const setIntervalSpy = jest.spyOn(global, 'setInterval');
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

      service.onModuleInit();

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 5000);

      service.onModuleDestroy();

      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    });

    it('invokes flush() on each tick', async () => {
      jest.useFakeTimers();
      stateStoreMock.readDirtyIds.mockResolvedValue([]);

      const flushSpy = jest.spyOn(service, 'flush');

      service.onModuleInit();

      await jest.advanceTimersByTimeAsync(5000);

      expect(flushSpy).toHaveBeenCalledTimes(1);

      service.onModuleDestroy();
    });

    it('does not throw when onModuleDestroy runs before onModuleInit', () => {
      expect(() => service.onModuleDestroy()).not.toThrow();
    });
  });
});
