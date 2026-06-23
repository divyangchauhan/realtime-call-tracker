import { plainToInstance } from 'class-transformer';
import { IsBoolean, IsEnum, IsNumber, IsOptional, IsString, validateSync } from 'class-validator';

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

  // ── PostgreSQL ──────────────────────────────────────────────────────────────

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

  // ── Redis ───────────────────────────────────────────────────────────────────
  // Default to the docker-compose service name so the app works inside the
  // Compose network without any extra configuration.

  @IsOptional()
  @IsString()
  REDIS_HOST: string = 'redis';

  @IsOptional()
  @IsNumber()
  REDIS_PORT: number = 6379;

  // ── Call state ──────────────────────────────────────────────────────────────

  /** How long (seconds) to keep live call state in Redis. */
  @IsOptional()
  @IsNumber()
  CALL_STATE_TTL_SECONDS: number = 3600;

  /**
   * Base WebSocket URL advertised to callers.
   * PR #7 will stand up the gateway at this address.
   */
  @IsOptional()
  @IsString()
  WS_PUBLIC_URL: string = 'ws://localhost:3000/ws';
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
