/**
 * Unit tests for CallCompletionService.
 *
 * Strategy:
 *  - TypeORM repository is mocked with a plain object ({ update: jest.fn() }).
 *  - RecordingDispatchService is mocked with { dispatch: jest.fn() }.
 *  - No real database or BullMQ connections are opened.
 *  - Tests cover: happy path, DB failure (early return, no dispatch),
 *    dispatch failure (does not throw after DB write succeeds).
 */

import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { Call } from '../database/entities/call.entity';
import { CallStatus } from '../database/entities/call-status.enum';
import { RecordingDispatchService } from '../recording/recording-dispatch.service';
import { CallCompletionService } from './call-completion.service';
import { CallState } from './call-state.store';

// Fixtures

function makeCallState(overrides: Partial<CallState> = {}): CallState {
  return {
    id: 'call-uuid-test',
    apiKeyId: 'api-key-1',
    from: '+15550001111',
    to: '+15550002222',
    status: CallStatus.COMPLETED,
    metadata: null,
    recordingUrl: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// Test suite

describe('CallCompletionService', () => {
  let service: CallCompletionService;
  let repoMock: { update: jest.Mock };
  let dispatchMock: { dispatch: jest.Mock };

  beforeEach(async () => {
    repoMock = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
    dispatchMock = { dispatch: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CallCompletionService,
        {
          provide: getRepositoryToken(Call),
          useValue: repoMock,
        },
        {
          provide: RecordingDispatchService,
          useValue: dispatchMock,
        },
      ],
    }).compile();

    service = module.get<CallCompletionService>(CallCompletionService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // Happy path

  describe('happy path', () => {
    it('updates the call row to COMPLETED with a completedAt Date', async () => {
      const state = makeCallState();

      await service.complete(state);

      expect(repoMock.update).toHaveBeenCalledTimes(1);
      expect(repoMock.update).toHaveBeenCalledWith(
        state.id,
        expect.objectContaining({
          status: CallStatus.COMPLETED,
          completedAt: expect.any(Date),
        }),
      );
    });

    it('dispatches a recording job after the Postgres write', async () => {
      const state = makeCallState();

      await service.complete(state);

      expect(dispatchMock.dispatch).toHaveBeenCalledTimes(1);
      expect(dispatchMock.dispatch).toHaveBeenCalledWith(state.id);
    });

    it('does not throw', async () => {
      await expect(service.complete(makeCallState())).resolves.not.toThrow();
    });
  });

  // DB failure: early return, no dispatch

  describe('when repo.update rejects', () => {
    beforeEach(() => {
      repoMock.update.mockRejectedValue(new Error('DB connection lost'));
    });

    it('does NOT call dispatch', async () => {
      await service.complete(makeCallState());

      expect(dispatchMock.dispatch).not.toHaveBeenCalled();
    });

    it('does not throw (swallows the error)', async () => {
      await expect(service.complete(makeCallState())).resolves.not.toThrow();
    });
  });

  // Dispatch failure: does not throw

  describe('when dispatch rejects', () => {
    beforeEach(() => {
      dispatchMock.dispatch.mockRejectedValue(new Error('BullMQ unavailable'));
    });

    it('does not throw even when dispatch fails', async () => {
      await expect(service.complete(makeCallState())).resolves.not.toThrow();
    });

    it('still called repo.update before dispatch failed', async () => {
      await service.complete(makeCallState());

      // DB write should have been attempted regardless.
      expect(repoMock.update).toHaveBeenCalledTimes(1);
    });
  });
});
