import { HttpException, HttpStatus } from '@nestjs/common';

/** The reason a rate-limit check was rejected. */
export type RateLimitReason = 'CPS' | 'CONCURRENCY';

/**
 * Thrown by CallsService when a per-API-key rate limit is exceeded.
 * Maps directly to HTTP 429 Too Many Requests.
 *
 * Body shape:
 *   { statusCode: 429, error: 'Too Many Requests', message: <human readable>, reason: <'CPS'|'CONCURRENCY'> }
 */
export class RateLimitExceededException extends HttpException {
  constructor(reason: RateLimitReason) {
    const message =
      reason === 'CPS'
        ? 'Rate limit exceeded: too many calls per second for this API key'
        : 'Rate limit exceeded: maximum concurrent calls reached for this API key';

    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'Too Many Requests',
        message,
        reason,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
