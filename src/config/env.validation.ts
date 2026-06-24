import { plainToInstance } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  validateSync,
} from 'class-validator';

enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

class EnvironmentVariables {
  @IsOptional()
  @IsEnum(Environment)
  NODE_ENV: Environment = Environment.Development;

  @IsOptional()
  @IsNumber()
  PORT: number = 3000;

  // PostgreSQL

  @IsOptional()
  @IsString()
  POSTGRES_HOST: string = 'localhost';

  @IsOptional()
  @IsNumber()
  POSTGRES_PORT: number = 5432;

  @IsOptional()
  @IsString()
  POSTGRES_USER: string = 'calluser';

  @IsOptional()
  @IsString()
  POSTGRES_PASSWORD: string = 'callpass';

  @IsOptional()
  @IsString()
  POSTGRES_DB: string = 'calltracker';

  @IsOptional()
  @IsBoolean()
  DB_RUN_MIGRATIONS: boolean = true;

  // Redis
  // Default to the docker-compose service name so the app works inside the
  // Compose network without any extra configuration.

  @IsOptional()
  @IsString()
  REDIS_HOST: string = 'redis';

  @IsOptional()
  @IsNumber()
  REDIS_PORT: number = 6379;

  // Call state

  /** How long (seconds) to keep live call state in Redis. */
  @IsOptional()
  @IsNumber()
  CALL_STATE_TTL_SECONDS: number = 3600;

  /**
   * Base WebSocket URL advertised to callers.
   * The gateway is served at this address.
   */
  @IsOptional()
  @IsString()
  WS_PUBLIC_URL: string = 'ws://localhost:3000/ws';

  // Call progression
  // All durations in milliseconds; probability is 0-1 float.
  // These env vars are entirely optional - the defaults produce a realistic
  // but fast-moving demo lifecycle (QUEUED→RINGING→ANSWERED→COMPLETED in ~6s).

  /** Delay (ms) from QUEUED before the call starts RINGING. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  PROGRESSION_QUEUED_TO_RINGING_MS: number = 1000;

  /** Duration (ms) the call rings before resolving to ANSWERED or UNANSWERED. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  PROGRESSION_RINGING_MS: number = 2000;

  /** Delay (ms) from ANSWERED before the call reaches COMPLETED. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  PROGRESSION_ANSWERED_TO_COMPLETED_MS: number = 3000;

  /** Delay (ms) from UNANSWERED before the call reaches COMPLETED. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  PROGRESSION_UNANSWERED_TO_COMPLETED_MS: number = 500;

  /**
   * Probability (0-1) that a RINGING call is ANSWERED.
   * The complement (1 - p) results in UNANSWERED.
   */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  PROGRESSION_ANSWER_PROBABILITY: number = 0.7;

  // S3 / LocalStack
  // All optional; defaults point to the docker-compose LocalStack service.

  @IsOptional()
  @IsString()
  S3_ENDPOINT: string = 'http://localstack:4566';

  @IsOptional()
  @IsString()
  AWS_REGION: string = 'us-east-1';

  @IsOptional()
  @IsString()
  AWS_ACCESS_KEY_ID: string = 'test';

  @IsOptional()
  @IsString()
  AWS_SECRET_ACCESS_KEY: string = 'test';

  @IsOptional()
  @IsString()
  S3_BUCKET: string = 'call-recordings';

  // Recording worker

  /** Path to the mock MP3 file the worker uploads. Resolved against cwd. */
  @IsOptional()
  @IsString()
  MOCK_RECORDING_PATH: string = 'assets/mock_recording.mp3';

  // Flush reconciliation

  /** Period (ms) between CallFlushService passes that reconcile write-behind. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  FLUSH_INTERVAL_MS: number = 5000;
}

/**
 * Validates environment variables using class-validator.
 * Called by ConfigModule during application bootstrap.
 * Throws if required variables are missing or have invalid values.
 */
export function validate(config: Record<string, unknown>): EnvironmentVariables {
  const normalized = {
    ...config,
    PORT: config.PORT !== undefined ? Number(config.PORT) : 3000,
    POSTGRES_PORT: config.POSTGRES_PORT !== undefined ? Number(config.POSTGRES_PORT) : 5432,
    REDIS_PORT: config.REDIS_PORT !== undefined ? Number(config.REDIS_PORT) : 6379,
    CALL_STATE_TTL_SECONDS:
      config.CALL_STATE_TTL_SECONDS !== undefined ? Number(config.CALL_STATE_TTL_SECONDS) : 3600,
    // Coerce "true"/"false" strings to booleans for class-validator @IsBoolean
    DB_RUN_MIGRATIONS:
      config.DB_RUN_MIGRATIONS !== undefined ? String(config.DB_RUN_MIGRATIONS) !== 'false' : true,
    // Progression timing - coerce string env vars to numbers.
    PROGRESSION_QUEUED_TO_RINGING_MS:
      config.PROGRESSION_QUEUED_TO_RINGING_MS !== undefined
        ? Number(config.PROGRESSION_QUEUED_TO_RINGING_MS)
        : 1000,
    PROGRESSION_RINGING_MS:
      config.PROGRESSION_RINGING_MS !== undefined ? Number(config.PROGRESSION_RINGING_MS) : 2000,
    PROGRESSION_ANSWERED_TO_COMPLETED_MS:
      config.PROGRESSION_ANSWERED_TO_COMPLETED_MS !== undefined
        ? Number(config.PROGRESSION_ANSWERED_TO_COMPLETED_MS)
        : 3000,
    PROGRESSION_UNANSWERED_TO_COMPLETED_MS:
      config.PROGRESSION_UNANSWERED_TO_COMPLETED_MS !== undefined
        ? Number(config.PROGRESSION_UNANSWERED_TO_COMPLETED_MS)
        : 500,
    PROGRESSION_ANSWER_PROBABILITY:
      config.PROGRESSION_ANSWER_PROBABILITY !== undefined
        ? Number(config.PROGRESSION_ANSWER_PROBABILITY)
        : 0.7,
    FLUSH_INTERVAL_MS:
      config.FLUSH_INTERVAL_MS !== undefined ? Number(config.FLUSH_INTERVAL_MS) : 5000,
  };

  const validatedConfig = plainToInstance(EnvironmentVariables, normalized, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validatedConfig, { skipMissingProperties: false });

  if (errors.length > 0) {
    throw new Error(`Environment validation failed:\n${errors.toString()}`);
  }

  return validatedConfig;
}
