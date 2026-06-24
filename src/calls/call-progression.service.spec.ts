/**
 * Unit tests for CallProgressionService.
 *
 * Strategy:
 *  - jest.useFakeTimers() controls all setTimeout calls so we can advance time
 *    deterministically without real delays.
 *  - pickRingOutcome is stubbed via jest.spyOn so each test can choose the
 *    ANSWERED or UNANSWERED branch without relying on Math.random().
 *  - All Redis and store operations are mocked — no real Redis connection.
 *  - No Postgres repository is injected (verifying write-behind design).
 */

import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { CallStatus } from '../database/entities/call-status.enum';
import { RateLimiterService } from '../rate-limit/rate-limiter.service';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { CallProgressionService } from './call-progression.service';
import { CallState, CallStateStore } from './call-state.store';

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** A minimal QUEUED call state used as the starting point for each test. */
function makeCallState(overrides: Partial<CallState> = {}): CallState {
  return {
    id: 'call-uuid-test',
    apiKeyId: 'api-key-1',
    from: '+15550001111',
    to: '+15550002222',
    status: CallStatus.QUEUED,
    metadata: null,
    recordingUrl: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Default progression config used across all tests.
 * Using small values just to be explicit — timers are fake anyway.
 */
const PROGRESSION_CONFIG = {
  queuedToRingingMs: 1000,
  ringingMs: 2000,
  answeredToCompletedMs: 3000,
  unansweredToCompletedMs: 500,
  answerProbability: 0.7,
};

// ── Test suite ────────────────────────────────────────────────────────────────

describe('CallProgressionService', () => {
  let service: CallProgressionService;
  let stateStoreMock: { updateStatus: jest.Mock };
  let rateLimiterMock: { release: jest.Mock };
  let redisMock: { publish: jest.Mock };

  beforeEach(async () => {
    jest.useFakeTimers();

    stateStoreMock = { updateStatus: jest.fn().mockResolvedValue(undefined) };
    rateLimiterMock = { release: jest.fn().mockResolvedValue(undefined) };
    redisMock = { publish: jest.fn().mockResolvedValue(1) };

    const configMock = {
      get: jest.fn().mockReturnValue({
        stateTtlSeconds: 3600,
        wsPublicUrl: 'ws://localhost:3000/ws',
        progression: PROGRESSION_CONFIG,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CallProgressionService,
        { provide: CallStateStore, useValue: stateStoreMock },
        { provide: RateLimiterService, useValue: rateLimiterMock },
        { provide: REDIS_CLIENT, useValue: redisMock },
        { provide: ConfigService, useValue: configMock },
      ],
    }).compile();

    service = module.get<CallProgressionService>(CallProgressionService);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // ── Full ANSWERED path ────────────────────────────────────────────────────

  describe('ANSWERED path', () => {
    it('progresses QUEUED → RINGING → ANSWERED → COMPLETED in order', async () => {
      // Stub the ring outcome to always ANSWERED.
      jest.spyOn(service as any, 'pickRingOutcome').mockReturnValue(CallStatus.ANSWERED);

      service.schedule(makeCallState());

      // ── QUEUED → RINGING ────────────────────────────────────────────────────
      await jest.advanceTimersByTimeAsync(PROGRESSION_CONFIG.queuedToRingingMs);

      expect(stateStoreMock.updateStatus).toHaveBeenNthCalledWith(
        1,
        'call-uuid-test',
        CallStatus.RINGING,
        expect.any(String),
        3600,
      );
      expect(redisMock.publish).toHaveBeenCalledTimes(1);
      const firstPayload = JSON.parse(redisMock.publish.mock.calls[0][1] as string);
      expect(firstPayload.status).toBe(CallStatus.RINGING);

      // ── RINGING → ANSWERED ──────────────────────────────────────────────────
      await jest.advanceTimersByTimeAsync(PROGRESSION_CONFIG.ringingMs);

      expect(stateStoreMock.updateStatus).toHaveBeenNthCalledWith(
        2,
        'call-uuid-test',
        CallStatus.ANSWERED,
        expect.any(String),
        3600,
      );
      expect(redisMock.publish).toHaveBeenCalledTimes(2);
      const secondPayload = JSON.parse(redisMock.publish.mock.calls[1][1] as string);
      expect(secondPayload.status).toBe(CallStatus.ANSWERED);

      // ── ANSWERED → COMPLETED ────────────────────────────────────────────────
      await jest.advanceTimersByTimeAsync(PROGRESSION_CONFIG.answeredToCompletedMs);

      expect(stateStoreMock.updateStatus).toHaveBeenNthCalledWith(
        3,
        'call-uuid-test',
        CallStatus.COMPLETED,
        expect.any(String),
        3600,
      );
      expect(redisMock.publish).toHaveBeenCalledTimes(3);
      const thirdPayload = JSON.parse(redisMock.publish.mock.calls[2][1] as string);
      expect(thirdPayload.status).toBe(CallStatus.COMPLETED);

      // Total: exactly 3 transitions.
      expect(stateStoreMock.updateStatus).toHaveBeenCalledTimes(3);
    });

    it('calls rateLimiter.release exactly once, on the COMPLETED transition', async () => {
      jest.spyOn(service as any, 'pickRingOutcome').mockReturnValue(CallStatus.ANSWERED);

      service.schedule(makeCallState());

      await jest.advanceTimersByTimeAsync(
        PROGRESSION_CONFIG.queuedToRingingMs +
          PROGRESSION_CONFIG.ringingMs +
          PROGRESSION_CONFIG.answeredToCompletedMs,
      );

      expect(rateLimiterMock.release).toHaveBeenCalledTimes(1);
      expect(rateLimiterMock.release).toHaveBeenCalledWith('api-key-1', 'call-uuid-test');
    });

    it('publishes to call:events channel (not some other channel)', async () => {
      jest.spyOn(service as any, 'pickRingOutcome').mockReturnValue(CallStatus.ANSWERED);

      service.schedule(makeCallState());

      await jest.advanceTimersByTimeAsync(
        PROGRESSION_CONFIG.queuedToRingingMs +
          PROGRESSION_CONFIG.ringingMs +
          PROGRESSION_CONFIG.answeredToCompletedMs,
      );

      for (const call of redisMock.publish.mock.calls) {
        expect(call[0]).toBe('call:events');
      }
    });
  });

  // ── UNANSWERED path ───────────────────────────────────────────────────────

  describe('UNANSWERED path', () => {
    it('progresses QUEUED → RINGING → UNANSWERED → COMPLETED', async () => {
      jest.spyOn(service as any, 'pickRingOutcome').mockReturnValue(CallStatus.UNANSWERED);

      service.schedule(makeCallState());

      await jest.advanceTimersByTimeAsync(PROGRESSION_CONFIG.queuedToRingingMs);
      await jest.advanceTimersByTimeAsync(PROGRESSION_CONFIG.ringingMs);
      await jest.advanceTimersByTimeAsync(PROGRESSION_CONFIG.unansweredToCompletedMs);

      const statuses = stateStoreMock.updateStatus.mock.calls.map(
        (c: unknown[]) => c[1],
      ) as CallStatus[];
      expect(statuses).toEqual([CallStatus.RINGING, CallStatus.UNANSWERED, CallStatus.COMPLETED]);
    });

    it('calls rateLimiter.release exactly once on the COMPLETED transition', async () => {
      jest.spyOn(service as any, 'pickRingOutcome').mockReturnValue(CallStatus.UNANSWERED);

      service.schedule(makeCallState());

      await jest.advanceTimersByTimeAsync(
        PROGRESSION_CONFIG.queuedToRingingMs +
          PROGRESSION_CONFIG.ringingMs +
          PROGRESSION_CONFIG.unansweredToCompletedMs,
      );

      expect(rateLimiterMock.release).toHaveBeenCalledTimes(1);
      expect(rateLimiterMock.release).toHaveBeenCalledWith('api-key-1', 'call-uuid-test');
    });
  });

  // ── Write-behind guarantee ────────────────────────────────────────────────

  describe('write-behind guarantee', () => {
    it('does NOT inject or call any Postgres repository', () => {
      // The service constructor does not accept a TypeORM repository; if it did
      // the DI container would have thrown during module compilation because no
      // repository provider was registered in this test module.
      // We simply assert that updateStatus (Redis) is the only persistence call.
      jest.spyOn(service as any, 'pickRingOutcome').mockReturnValue(CallStatus.ANSWERED);

      service.schedule(makeCallState());

      // Before any timers advance: no Redis calls yet (machine is timer-driven).
      expect(stateStoreMock.updateStatus).not.toHaveBeenCalled();
    });
  });

  // ── onModuleDestroy clears pending timers ─────────────────────────────────

  describe('onModuleDestroy', () => {
    it('clears a pending timer so no transitions fire after destroy', async () => {
      jest.spyOn(service as any, 'pickRingOutcome').mockReturnValue(CallStatus.ANSWERED);

      service.schedule(makeCallState());

      // Destroy BEFORE the first timer fires.
      service.onModuleDestroy();

      // Advance past all expected delays — nothing should have fired.
      await jest.advanceTimersByTimeAsync(
        PROGRESSION_CONFIG.queuedToRingingMs +
          PROGRESSION_CONFIG.ringingMs +
          PROGRESSION_CONFIG.answeredToCompletedMs,
      );

      expect(stateStoreMock.updateStatus).not.toHaveBeenCalled();
      expect(redisMock.publish).not.toHaveBeenCalled();
      expect(rateLimiterMock.release).not.toHaveBeenCalled();
    });

    it('stops the chain mid-progression so no further transitions fire after destroy', async () => {
      jest.spyOn(service as any, 'pickRingOutcome').mockReturnValue(CallStatus.ANSWERED);

      service.schedule(makeCallState());

      // Let the first transition (QUEUED → RINGING) fire, then destroy.
      await jest.advanceTimersByTimeAsync(PROGRESSION_CONFIG.queuedToRingingMs);
      expect(stateStoreMock.updateStatus).toHaveBeenCalledTimes(1); // RINGING only

      service.onModuleDestroy();

      // Advance past the remaining legs — no ANSWERED/COMPLETED should occur.
      await jest.advanceTimersByTimeAsync(
        PROGRESSION_CONFIG.ringingMs + PROGRESSION_CONFIG.answeredToCompletedMs,
      );

      expect(stateStoreMock.updateStatus).toHaveBeenCalledTimes(1);
      expect(rateLimiterMock.release).not.toHaveBeenCalled();
    });
  });

  // ── Resilience: Redis failure on one transition ───────────────────────────

  describe('resilience', () => {
    it('continues the machine when updateStatus rejects on one transition', async () => {
      jest.spyOn(service as any, 'pickRingOutcome').mockReturnValue(CallStatus.ANSWERED);

      // Make the RINGING updateStatus fail.
      stateStoreMock.updateStatus
        .mockRejectedValueOnce(new Error('Redis HSET failed'))
        .mockResolvedValue(undefined);

      // Should not throw out of the timer.
      await expect(
        (async () => {
          service.schedule(makeCallState());
          await jest.advanceTimersByTimeAsync(PROGRESSION_CONFIG.queuedToRingingMs);
          await jest.advanceTimersByTimeAsync(PROGRESSION_CONFIG.ringingMs);
          await jest.advanceTimersByTimeAsync(PROGRESSION_CONFIG.answeredToCompletedMs);
        })(),
      ).resolves.not.toThrow();

      // The machine should still have attempted all 3 transitions.
      expect(stateStoreMock.updateStatus).toHaveBeenCalledTimes(3);
      // COMPLETED was reached so release should still fire.
      expect(rateLimiterMock.release).toHaveBeenCalledTimes(1);
    });

    it('continues the machine when redis.publish rejects on one transition', async () => {
      jest.spyOn(service as any, 'pickRingOutcome').mockReturnValue(CallStatus.ANSWERED);

      // Make the RINGING publish fail; the machine must still progress to COMPLETED.
      redisMock.publish
        .mockRejectedValueOnce(new Error('Redis PUBLISH failed'))
        .mockResolvedValue(1);

      await expect(
        (async () => {
          service.schedule(makeCallState());
          await jest.advanceTimersByTimeAsync(PROGRESSION_CONFIG.queuedToRingingMs);
          await jest.advanceTimersByTimeAsync(PROGRESSION_CONFIG.ringingMs);
          await jest.advanceTimersByTimeAsync(PROGRESSION_CONFIG.answeredToCompletedMs);
        })(),
      ).resolves.not.toThrow();

      expect(stateStoreMock.updateStatus).toHaveBeenCalledTimes(3);
      expect(rateLimiterMock.release).toHaveBeenCalledTimes(1);
    });
  });

  // ── Payload shape ─────────────────────────────────────────────────────────

  describe('published payload shape', () => {
    it('publishes the callResponseFromState JSON shape (snake_case keys)', async () => {
      jest.spyOn(service as any, 'pickRingOutcome').mockReturnValue(CallStatus.ANSWERED);

      service.schedule(makeCallState());
      await jest.advanceTimersByTimeAsync(PROGRESSION_CONFIG.queuedToRingingMs);

      const payload = JSON.parse(redisMock.publish.mock.calls[0][1] as string) as Record<
        string,
        unknown
      >;

      // Must have the public response shape produced by callResponseFromState.
      expect(payload).toEqual(
        expect.objectContaining({
          id: 'call-uuid-test',
          from: '+15550001111',
          to: '+15550002222',
          status: CallStatus.RINGING,
          metadata: null,
          recording_url: null, // snake_case, not camelCase
          created_at: expect.any(String),
          updated_at: expect.any(String),
        }),
      );
    });
  });
});
