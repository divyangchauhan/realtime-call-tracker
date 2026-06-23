import { SetMetadata } from '@nestjs/common';

/** Metadata key used by ApiKeyAuthGuard to detect public routes. */
export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Mark a controller or handler as public (no API key required).
 * When applied, ApiKeyAuthGuard skips authentication entirely.
 *
 * @example
 * @Public()
 * @Controller('health')
 * export class HealthController { ... }
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
