/**
 * Typed configuration factory loaded by ConfigModule.
 * Returns a structured object read from environment variables with sensible defaults.
 */

export interface Configuration {
  app: {
    port: number;
    nodeEnv: string;
  };
  database: {
    host: string;
    port: number;
    username: string;
    password: string;
    name: string;
    runMigrations: boolean;
  };
  redis: {
    host: string;
    port: number;
  };
  /**
   * AWS S3 (or LocalStack) configuration used by RecordingStorageService (PR #9).
   * Defaults allow the worker to talk to the docker-compose LocalStack service
   * without any extra environment setup.
   */
  s3: {
    /** HTTP endpoint for LocalStack (or real AWS when blank). */
    endpoint: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    /** Bucket that holds recorded-call audio files. */
    bucket: string;
    /**
     * Force path-style URLs (e.g. http://host/bucket/key) instead of the
     * default virtual-host style (bucket.host/key).  LocalStack requires this.
     */
    forcePathStyle: boolean;
  };
  /**
   * Recording-worker configuration (PR #9).
   */
  recording: {
    /**
     * Filesystem path to the mock MP3 asset that the worker uploads to S3.
     * Resolved against process.cwd() at use time.
     * Env var: MOCK_RECORDING_PATH (default: assets/mock_recording.mp3).
     */
    mockFilePath: string;
  };
  call: {
    /** Seconds to keep live call state in Redis. Default 3600 (1 hour). */
    stateTtlSeconds: number;
    /**
     * Public WebSocket base URL advertised to callers.
     * PR #7 will stand up the actual gateway at this address.
     */
    wsPublicUrl: string;
    /**
     * Timing and probability parameters for the background auto-progression
     * engine (PR #6).  Each field drives one leg of the state machine:
     *
     *   QUEUED ──[queuedToRingingMs]──► RINGING
     *   RINGING ──[ringingMs]──► ANSWERED (p=answerProbability) | UNANSWERED
     *   ANSWERED ──[answeredToCompletedMs]──► COMPLETED
     *   UNANSWERED ──[unansweredToCompletedMs]──► COMPLETED
     */
    progression: {
      /** Delay (ms) from QUEUED before the call starts RINGING. */
      queuedToRingingMs: number;
      /** Duration (ms) the call rings before resolving to ANSWERED or UNANSWERED. */
      ringingMs: number;
      /** Delay (ms) from ANSWERED before the call reaches COMPLETED. */
      answeredToCompletedMs: number;
      /** Delay (ms) from UNANSWERED before the call reaches COMPLETED. */
      unansweredToCompletedMs: number;
      /**
       * Probability (0–1) that a RINGING call is ANSWERED.
       * The complement (1 − p) is the UNANSWERED probability.
       */
      answerProbability: number;
    };
  };
}

export default (): Configuration => ({
  app: {
    port: parseInt(process.env.PORT ?? '3000', 10),
    nodeEnv: process.env.NODE_ENV ?? 'development',
  },
  database: {
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
    username: process.env.POSTGRES_USER ?? 'calluser',
    password: process.env.POSTGRES_PASSWORD ?? 'callpass',
    name: process.env.POSTGRES_DB ?? 'calltracker',
    runMigrations: (process.env.DB_RUN_MIGRATIONS ?? 'true') !== 'false',
  },
  redis: {
    host: process.env.REDIS_HOST ?? 'redis',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  },
  s3: {
    // This project targets LocalStack (port 4566 on the docker-compose network),
    // so path-style addressing is required and hardcoded below. Pointing at real
    // AWS would additionally require making forcePathStyle configurable and using
    // the regional endpoint — out of scope for this take-home.
    endpoint: process.env.S3_ENDPOINT ?? 'http://localstack:4566',
    region: process.env.AWS_REGION ?? 'us-east-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    bucket: process.env.S3_BUCKET ?? 'call-recordings',
    // LocalStack requires path-style URLs; the SDK default is virtual-host style.
    forcePathStyle: true,
  },
  recording: {
    // Resolved against process.cwd() at use time so it works in both the
    // ts-node (cwd = project root) and compiled dist (cwd = /app) contexts.
    mockFilePath: process.env.MOCK_RECORDING_PATH ?? 'assets/mock_recording.mp3',
  },
  call: {
    stateTtlSeconds: parseInt(process.env.CALL_STATE_TTL_SECONDS ?? '3600', 10),
    wsPublicUrl: process.env.WS_PUBLIC_URL ?? 'ws://localhost:3000/ws',
    progression: {
      queuedToRingingMs: parseInt(process.env.PROGRESSION_QUEUED_TO_RINGING_MS ?? '1000', 10),
      ringingMs: parseInt(process.env.PROGRESSION_RINGING_MS ?? '2000', 10),
      answeredToCompletedMs: parseInt(
        process.env.PROGRESSION_ANSWERED_TO_COMPLETED_MS ?? '3000',
        10,
      ),
      unansweredToCompletedMs: parseInt(
        process.env.PROGRESSION_UNANSWERED_TO_COMPLETED_MS ?? '500',
        10,
      ),
      answerProbability: parseFloat(process.env.PROGRESSION_ANSWER_PROBABILITY ?? '0.7'),
    },
  },
});
