import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthenticatedRequest, RequestApiKey } from './auth.types';

/**
 * Parameter decorator that extracts the authenticated API key from the request.
 * Populated by ApiKeyAuthGuard after successful authentication.
 *
 * @example
 * @Get('calls')
 * getCalls(@CurrentApiKey() apiKey: RequestApiKey) { ... }
 */
export const CurrentApiKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestApiKey | undefined => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.apiKey;
  },
);
