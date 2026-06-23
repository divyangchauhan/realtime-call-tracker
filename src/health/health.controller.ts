import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/public.decorator';

interface HealthResponse {
  status: 'ok';
  timestamp: string;
}

/**
 * Health controller providing a liveness endpoint.
 * DB and Redis readiness checks will be added in a later PR once those services are wired up.
 *
 * @Public() allows Docker's wget healthcheck (and monitoring systems) to reach /health
 * without an API key — required because the global ApiKeyAuthGuard is applied to all routes.
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
