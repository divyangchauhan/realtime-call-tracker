import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CreateBucketCommand, PutObjectCommand, BucketAlreadyOwnedByYou } from '@aws-sdk/client-s3';
import { RecordingStorageService } from './recording-storage.service';

/**
 * Unit tests for RecordingStorageService.
 *
 * We mock @aws-sdk/client-s3 so no real network calls are made.
 * S3Client is replaced by a jest class mock.  The `send` function is stored
 * on `mockS3Container` so the hoisted jest.mock() factory and the test body
 * share a reference without triggering the temporal-dead-zone error that
 * would occur with a plain `let` variable.
 *
 * All command / error classes are kept real so `instanceof` checks in the
 * service (for BucketAlreadyExists / BucketAlreadyOwnedByYou) still work.
 */

// Plain object declared with `const` is initialised before the hoisted
// jest.mock() factory runs, so the factory can safely close over it.
const mockS3Container = { send: jest.fn() };

jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual<typeof import('@aws-sdk/client-s3')>('@aws-sdk/client-s3');
  return {
    ...actual,
    // Every new S3Client() returns the same shared mock so tests can assert
    // on a single `send` reference without tracking instance indices.
    S3Client: jest.fn().mockImplementation(() => mockS3Container),
  };
});

/** Helper: build a ConfigService stub returning our test s3 config block. */
function makeConfigService(overrides: Record<string, unknown> = {}): ConfigService {
  const s3Config = {
    endpoint: 'http://localhost:4566',
    region: 'us-east-1',
    accessKeyId: 'test',
    secretAccessKey: 'test',
    bucket: 'call-recordings',
    forcePathStyle: true,
    ...overrides,
  };

  return {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 's3') return s3Config;
      if (key === 'recording') return { mockFilePath: 'assets/mock_recording.mp3' };
      return undefined;
    }),
  } as unknown as ConfigService;
}

describe('RecordingStorageService', () => {
  let service: RecordingStorageService;

  beforeEach(async () => {
    // Reset call history before every test.
    mockS3Container.send.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecordingStorageService,
        { provide: ConfigService, useValue: makeConfigService() },
      ],
    }).compile();

    service = module.get<RecordingStorageService>(RecordingStorageService);
  });

  // onModuleInit

  describe('onModuleInit', () => {
    it('calls CreateBucketCommand with the configured bucket name', async () => {
      mockS3Container.send.mockResolvedValueOnce({});

      await service.onModuleInit();

      expect(mockS3Container.send).toHaveBeenCalledTimes(1);

      // The command passed to send() must be a CreateBucketCommand for our bucket.
      const [cmd] = mockS3Container.send.mock.calls[0] as [CreateBucketCommand];
      expect(cmd).toBeInstanceOf(CreateBucketCommand);
      expect((cmd as CreateBucketCommand & { input: { Bucket: string } }).input.Bucket).toBe(
        'call-recordings',
      );
    });

    it('swallows BucketAlreadyOwnedByYou so the worker still starts', async () => {
      // LocalStack / AWS returns this when the bucket already exists.
      mockS3Container.send.mockRejectedValueOnce(
        new BucketAlreadyOwnedByYou({ message: 'already exists', $metadata: {} }),
      );

      // onModuleInit must resolve - it must NOT rethrow this error.
      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });

    it('swallows unexpected bucket-creation errors and does not crash', async () => {
      // Generic error (e.g. LocalStack not ready at startup).
      mockS3Container.send.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });
  });

  // upload

  describe('upload', () => {
    beforeEach(() => {
      // All upload tests: send() resolves successfully by default.
      mockS3Container.send.mockResolvedValue({});
    });

    it('issues a PutObjectCommand with correct Bucket, Key, Body, and ContentType', async () => {
      const buf = Buffer.from('fake-audio-bytes');
      await service.upload('recordings/abc-123.mp3', buf, 'audio/mpeg');

      // Find the PutObjectCommand call (there may also be a CreateBucket call from init).
      const putCall = mockS3Container.send.mock.calls.find(
        ([cmd]: [unknown]) => cmd instanceof PutObjectCommand,
      );
      expect(putCall).toBeDefined();

      const putCmd = putCall![0] as PutObjectCommand & {
        input: { Bucket: string; Key: string; Body: Buffer; ContentType: string };
      };
      expect(putCmd.input.Bucket).toBe('call-recordings');
      expect(putCmd.input.Key).toBe('recordings/abc-123.mp3');
      expect(putCmd.input.Body).toBe(buf);
      expect(putCmd.input.ContentType).toBe('audio/mpeg');
    });

    it('returns the path-style URL: ${endpoint}/${bucket}/${key}', async () => {
      const buf = Buffer.from('fake-audio');
      const url = await service.upload('recordings/x.mp3', buf, 'audio/mpeg');

      expect(url).toBe('http://localhost:4566/call-recordings/recordings/x.mp3');
    });

    it('strips a trailing slash from the endpoint before building the URL', async () => {
      // Rebuild the module with an endpoint that has a trailing slash.
      mockS3Container.send.mockReset();
      mockS3Container.send.mockResolvedValue({});

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RecordingStorageService,
          {
            provide: ConfigService,
            useValue: makeConfigService({ endpoint: 'http://localhost:4566/' }),
          },
        ],
      }).compile();

      const svc = module.get<RecordingStorageService>(RecordingStorageService);
      const url = await svc.upload('recordings/x.mp3', Buffer.from(''), 'audio/mpeg');

      // Must not produce a double-slash.
      expect(url).toBe('http://localhost:4566/call-recordings/recordings/x.mp3');
    });

    it('propagates PutObjectCommand errors so the BullMQ job is retried', async () => {
      mockS3Container.send.mockReset();
      mockS3Container.send.mockRejectedValueOnce(new Error('S3 upload failed'));

      await expect(
        service.upload('recordings/fail.mp3', Buffer.from(''), 'audio/mpeg'),
      ).rejects.toThrow('S3 upload failed');
    });
  });
});
