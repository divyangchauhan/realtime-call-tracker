import { plainToInstance } from 'class-transformer';
import { IsEnum, IsNumber, IsOptional, validateSync } from 'class-validator';

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
}

/**
 * Validates environment variables using class-validator.
 * Called by ConfigModule during application bootstrap.
 * Throws if required variables are missing or have invalid values.
 */
export function validate(config: Record<string, unknown>): EnvironmentVariables {
  // Coerce PORT to a number before validation
  const normalized = {
    ...config,
    PORT: config.PORT !== undefined ? Number(config.PORT) : 3000,
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
