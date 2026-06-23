import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { hashApiKey } from '../common/crypto.util';
import { ApiKey } from '../database/entities/api-key.entity';
import { AuthenticatedRequest } from './auth.types';
import { IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class ApiKeyAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectRepository(ApiKey)
    private readonly apiKeys: Repository<ApiKey>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check whether the route (handler or class) is marked @Public().
    // getAllAndOverride returns the handler-level value if set, otherwise the class-level value.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authHeader: string | undefined = request.headers['authorization'];

    // Require the header to be present.
    if (!authHeader) {
      throw new UnauthorizedException('Missing or malformed Authorization header');
    }

    // Require exactly "Bearer <token>" (case-insensitive scheme, exactly one token part).
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer' || !parts[1]) {
      throw new UnauthorizedException('Missing or malformed Authorization header');
    }

    const token = parts[1];

    // Hash the raw token before querying the DB — we never store or log plaintext keys.
    const keyHash = hashApiKey(token);

    // Look up the active key by its hash. Inactive keys are treated as non-existent
    // to avoid leaking information about whether a key exists vs is suspended.
    const apiKey = await this.apiKeys.findOne({ where: { keyHash, isActive: true } });
    if (!apiKey) {
      throw new UnauthorizedException('Invalid API key');
    }

    // Attach the key's id and rate-limit parameters to the request for downstream use
    // (e.g. PR #5's Redis Lua rate limiter reads maxConcurrent / maxCps from here).
    request.apiKey = {
      id: apiKey.id,
      name: apiKey.name,
      maxConcurrent: apiKey.maxConcurrent,
      maxCps: apiKey.maxCps,
    };

    return true;
  }
}
