import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { RecordingProcessor } from './recording.processor';
import { RecordingStorageService } from './recording-storage.service';
import { RECORDING_JOB } from './recording.constants';
import { Call } from '../database/entities/call.entity';
import { CallStateStore } from '../calls/call-state.store';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { CallStatus } from '../database/entities/call-status.enum';

/**
 * Unit tests for RecordingProcessor.
 *
 * All external dependencies are mocked:
 *  - RecordingStorageService.upload  → resolves to a fake URL
 *  - Call Repository.update          → resolves successfully
 *  - CallStateStore.updateRecordingUrl / .read → configurable per test
 *  - REDIS_CLIENT.publish            → configurable per test
 *  - ConfigService                   → returns test config values
 *  - fs/promises.readFile            → mocked to return a fixed Buffer
 *
 * No real S3, Redis, or Postgres connections are opened.
 */

// Mock fs/promises so readFile returns a predictable Buffer.
// This avoids any filesystem access during tests.
jest.mock('fs/promises', () => ({
  readFile: jest.fn().mockResolvedValue(Buffer.from('mock-audio-bytes')),
}));

/** A minimal CallState for the stateStore.read mock. */
const MOCK_STATE = {
  id: 'call-uuid-1',
  apiKeyId: 'key-1',
  from: '+15550001111',
  to: '+15550002222',
  status: CallStatus.COMPLETED,
  metadata: null,
  recordingUrl: 'http://localhost:4566/call-recordings/recordings/call-uuid-1.mp3',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:01:00.000Z',
};

const MOCK_URL = 'http://localhost:4566/call-recordings/recordings/call-uuid-1.mp3';

/** Build the NestJS testing module with all deps mocked. */
async function buildModule(overrides: {
  storageUpload?: jest.Mock;
  repoUpdate?: jest.Mock;
  storeUpdateRecordingUrl?: jest.Mock;
  storeRead?: jest.Mock;
  redisPublish?: jest.Mock;
}) {
  const storageMock = {
    upload: overrides.storageUpload ?? jest.fn().mockResolvedValue(MOCK_URL),
  };

  const repoMock = {
    update: overrides.repoUpdate ?? jest.fn().mockResolvedValue({ affected: 1 }),
  };

  const stateStoreMock = {
    updateRecordingUrl: overrides.storeUpdateRecordingUrl ?? jest.fn().mockResolvedValue(undefined),
    read: overrides.storeRead ?? jest.fn().mockResolvedValue(MOCK_STATE),
  };

  const redisMock = {
    publish: overrides.redisPublish ?? jest.fn().mockResolvedValue(1),
  };

  const configMock = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'recording') return { mockFilePath: 'assets/mock_recording.mp3' };
      if (key === 'call') return { stateTtlSeconds: 3600 };
      return undefined;
    }),
  };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      RecordingProcessor,
      { provide: RecordingStorageService, useValue: storageMock },
      { provide: getRepositoryToken(Call), useValue: repoMock },
      { provide: CallStateStore, useValue: stateStoreMock },
      { provide: REDIS_CLIENT, useValue: redisMock },
      { provide: ConfigService, useValue: configMock },
    ],
  }).compile();

  return {
    processor: module.get<RecordingProcessor>(RecordingProcessor),
    storageMock,
    repoMock,
    stateStoreMock,
    redisMock,
  };
}

/** Build a minimal Job mock - BullMQ's Job<T> is used only for name/data/id. */
function makeJob(callId: string): Job<{ callId: string }> {
  return {
    name: RECORDING_JOB,
    data: { callId },
    id: `job-${callId}`,
  } as unknown as Job<{ callId: string }>;
}

describe('RecordingProcessor', () => {
  // Happy path

  describe('process() - happy path', () => {
    it('uploads with the deterministic key recordings/<callId>.mp3', async () => {
      const { processor, storageMock } = await buildModule({});

      await processor.process(makeJob('call-uuid-1'));

      // The S3 key must be deterministic so retries are idempotent.
      expect(storageMock.upload).toHaveBeenCalledWith(
        'recordings/call-uuid-1.mp3',
        expect.any(Buffer),
        'audio/mpeg',
      );
    });

    it('calls repo.update with the callId and the returned URL', async () => {
      const { processor, repoMock } = await buildModule({});

      await processor.process(makeJob('call-uuid-1'));

      expect(repoMock.update).toHaveBeenCalledWith('call-uuid-1', { recordingUrl: MOCK_URL });
    });

    it('calls stateStore.updateRecordingUrl with the URL and a non-empty ISO timestamp', async () => {
      const { processor, stateStoreMock } = await buildModule({});

      await processor.process(makeJob('call-uuid-1'));

      expect(stateStoreMock.updateRecordingUrl).toHaveBeenCalledWith(
        'call-uuid-1',
        MOCK_URL,
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), // ISO 8601 timestamp
        3600,
      );
    });

    it('publishes a WS event to CALL_EVENTS_CHANNEL with recording_url set', async () => {
      const { processor, redisMock } = await buildModule({});

      await processor.process(makeJob('call-uuid-1'));

      expect(redisMock.publish).toHaveBeenCalledTimes(1);
      const [channel, rawPayload] = redisMock.publish.mock.calls[0] as [string, string];

      expect(channel).toBe('call:events');

      const payload = JSON.parse(rawPayload) as { recording_url: string; id: string };
      expect(payload.recording_url).toBe(MOCK_URL);
      expect(payload.id).toBe('call-uuid-1');
    });

    it('returns { recordingUrl } on success', async () => {
      const { processor } = await buildModule({});

      const result = await processor.process(makeJob('call-uuid-1'));

      expect(result).toEqual({ recordingUrl: MOCK_URL });
    });
  });

  // Guard: unexpected job name

  describe('process() - unexpected job name', () => {
    it('throws and does NOT upload when the job name is not upload-recording', async () => {
      const { processor, storageMock } = await buildModule({});
      const foreignJob = {
        name: 'some-other-job',
        data: { callId: 'call-uuid-1' },
        id: 'job-x',
      } as unknown as Job<{ callId: string }>;

      await expect(processor.process(foreignJob)).rejects.toThrow('unexpected job name');
      expect(storageMock.upload).not.toHaveBeenCalled();
    });
  });

  // Throw-to-retry: repo.update failure

  describe('process() - repo.update rejects', () => {
    it('throws so BullMQ retries the job', async () => {
      const { processor } = await buildModule({
        repoUpdate: jest.fn().mockRejectedValue(new Error('DB connection lost')),
      });

      await expect(processor.process(makeJob('call-uuid-1'))).rejects.toThrow('DB connection lost');
    });
  });

  // Throw-to-retry: storage.upload failure

  describe('process() - storage.upload rejects', () => {
    it('throws so BullMQ retries the job', async () => {
      const { processor } = await buildModule({
        storageUpload: jest.fn().mockRejectedValue(new Error('S3 unavailable')),
      });

      await expect(processor.process(makeJob('call-uuid-1'))).rejects.toThrow('S3 unavailable');
    });
  });

  // Best-effort: Redis cache failure still resolves

  describe('process() - stateStore.updateRecordingUrl rejects (best-effort)', () => {
    it('resolves successfully even when the Redis cache update fails', async () => {
      const { processor } = await buildModule({
        storeUpdateRecordingUrl: jest.fn().mockRejectedValue(new Error('Redis down')),
      });

      // The job must still succeed - Redis is a best-effort cache layer.
      const result = await processor.process(makeJob('call-uuid-1'));
      expect(result).toEqual({ recordingUrl: MOCK_URL });
    });
  });

  // Best-effort: Redis publish failure still resolves

  describe('process() - redis.publish rejects (best-effort)', () => {
    it('resolves successfully even when the WS publish fails', async () => {
      const { processor } = await buildModule({
        redisPublish: jest.fn().mockRejectedValue(new Error('Redis publish error')),
      });

      const result = await processor.process(makeJob('call-uuid-1'));
      expect(result).toEqual({ recordingUrl: MOCK_URL });
    });
  });

  // Best-effort: state not in Redis (no WS publish)

  describe('process() - stateStore.read returns null (state expired)', () => {
    it('skips the WS publish but still resolves', async () => {
      const { processor, redisMock } = await buildModule({
        storeRead: jest.fn().mockResolvedValue(null),
      });

      const result = await processor.process(makeJob('call-uuid-1'));
      expect(result).toEqual({ recordingUrl: MOCK_URL });
      // publish must not be called when state is null.
      expect(redisMock.publish).not.toHaveBeenCalled();
    });
  });
});
