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
