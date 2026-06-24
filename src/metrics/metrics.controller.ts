import { Controller, Get } from '@nestjs/common';
import { RequestApiKey } from '../auth/auth.types';
import { CurrentApiKey } from '../auth/current-api-key.decorator';
import { MetricsResponse } from './dto/metrics-response.dto';
import { MetricsService } from './metrics.service';

/**
 * Handles GET /metrics.
 *
 * Deliberately NOT @Public(): metrics are scoped to the calling API key (see
 * MetricsService.getMetrics), so this route MUST go through the global
 * ApiKeyAuthGuard like every other business endpoint. Exposing it publicly
 * would either leak the snapshot of an arbitrary tenant (if unauthenticated
 * requests defaulted to some key) or require fanning out across ALL keys,
 * which is explicitly out of scope - this is a per-tenant operational view,
 * not a global admin one. Contrast with HealthController, which IS @Public()
 * because liveness checks have no tenant-specific data to leak.
 */
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  /**
   * GET /metrics
   * Returns an operational snapshot (call counts by status, recordings
   * present, live concurrency, configured limits) scoped to the authenticated
   * caller's own API key. @CurrentApiKey() is populated by ApiKeyAuthGuard
   * after successful authentication - see auth/current-api-key.decorator.ts.
   */
  @Get()
  async getMetrics(@CurrentApiKey() apiKey: RequestApiKey): Promise<MetricsResponse> {
    return this.metricsService.getMetrics(apiKey);
  }
}
