/**
 * Unit tests for RecordingDispatchService.
 *
 * Strategy:
 *  - The BullMQ queue is replaced with a plain mock object ({ add: jest.fn() })
 *    so no real Redis / BullMQ connection is opened.
 *  - We provide the mock via the BullMQ queue token (getQueueToken) so NestJS
 *    resolves the @InjectQueue() decorator without importing BullModule.
 */

import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { RECORDING_JOB, RECORDING_QUEUE } from './recording.constants';
import { RecordingDispatchService } from './recording-dispatch.service';

describe('RecordingDispatchService', () => {
  let service: RecordingDispatchService;
  let queueMock: { add: jest.Mock };

  beforeEach(async () => {
    queueMock = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecordingDispatchService,
        // Provide the BullMQ queue token directly - no BullModule import needed.
        {
          provide: getQueueToken(RECORDING_QUEUE),
          useValue: queueMock,
        },
      ],
    }).compile();

    service = module.get<RecordingDispatchService>(RecordingDispatchService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('calls queue.add with the correct job name and payload', async () => {
    await service.dispatch('call-1');

    expect(queueMock.add).toHaveBeenCalledTimes(1);
    expect(queueMock.add).toHaveBeenCalledWith(
      RECORDING_JOB,
      { callId: 'call-1' },
      expect.objectContaining({
        jobId: 'call-1',
        attempts: 3,
      }),
    );
  });

  it('passes jobId: callId for idempotent deduplication', async () => {
    await service.dispatch('call-abc');

    const [, , options] = queueMock.add.mock.calls[0] as [string, unknown, Record<string, unknown>];
    expect(options).toMatchObject({ jobId: 'call-abc' });
  });

  it('passes attempts: 3 for retry resilience', async () => {
    await service.dispatch('call-xyz');

    const [, , options] = queueMock.add.mock.calls[0] as [string, unknown, Record<string, unknown>];
    expect(options).toMatchObject({ attempts: 3 });
  });

  it('uses exponential backoff with delay: 1000', async () => {
    await service.dispatch('call-2');

    const [, , options] = queueMock.add.mock.calls[0] as [string, unknown, Record<string, unknown>];
    expect(options).toMatchObject({
      backoff: { type: 'exponential', delay: 1000 },
    });
  });

  it('sets removeOnComplete: true and removeOnFail: false', async () => {
    await service.dispatch('call-3');

    const [, , options] = queueMock.add.mock.calls[0] as [string, unknown, Record<string, unknown>];
    expect(options).toMatchObject({
      removeOnComplete: true,
      removeOnFail: false,
    });
  });
});
