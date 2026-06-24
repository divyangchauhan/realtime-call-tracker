import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/public.decorator';

interface HealthResponse {
  status: 'ok';
  timestamp: string;
}

/**
 * Health controller providing a liveness endpoint.
 * This is a liveness probe only; it does not assert DB or Redis readiness.
 *
 * @Public() allows Docker's wget healthcheck (and monitoring systems) to reach /health
 * without an API key - required because the global ApiKeyAuthGuard is applied to all routes.
 */
@Public()
@Controller('health')
export class HealthController {
  @Get()
  check(): HealthResponse {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }
}
