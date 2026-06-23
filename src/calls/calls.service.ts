import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Configuration } from '../config/configuration';
import { Call } from '../database/entities/call.entity';
import { CallStatus } from '../database/entities/call-status.enum';
import { RequestApiKey } from '../auth/auth.types';
import { CallStateStore } from './call-state.store';
import { CreateCallDto } from './dto/create-call.dto';
import {
  CallResponse,
  callResponseFromEntity,
  callResponseFromState,
} from './dto/call-response.dto';

export interface CreateCallResult {
  call_id: string;
  websocket_url: string;
}

/**
 * Business logic for the /calls endpoints.
 *
 * Extension points for upcoming PRs (do NOT implement here):
 *  - PR #5: insert a Redis Lua rate-limit gate before createCall persists.
 *  - PR #8: wrap the completed-transition in a transaction that also enqueues
 *           a BullMQ recording job.
 */
@Injectable()
export class CallsService {
  private readonly logger = new Logger(CallsService.name);

  constructor(
    @InjectRepository(Call)
    private readonly callRepo: Repository<Call>,
    private readonly stateStore: CallStateStore,
    private readonly config: ConfigService<Configuration, true>,
  ) {}

  /**
   * Create a new call record and mirror it to Redis live state.
   *
   * Write-through strategy:
   *  1. Persist to Postgres (durable source of truth).
   *  2. Mirror to Redis (best-effort — if Redis is down, GET /calls/:id
   *     falls back to Postgres automatically, so the call is not lost).
   */
  async createCall(apiKey: RequestApiKey, dto: CreateCallDto): Promise<CreateCallResult> {
    // ── 1. Durable write to Postgres ─────────────────────────────────────────
    const entity = this.callRepo.create({
      apiKeyId: apiKey.id,
      fromNumber: dto.from,
      toNumber: dto.to,
      status: CallStatus.QUEUED,
      metadata: dto.metadata ?? null,
    });
    const saved = await this.callRepo.save(entity);

    // ── 2. Mirror to Redis (best-effort) ─────────────────────────────────────
    // If Redis is unavailable we log a warning but DO NOT fail the request —
    // the row is already durably in Postgres and the GET endpoint falls back.
    const ttl = this.config.get('call', { infer: true }).stateTtlSeconds;
    try {
      await this.stateStore.write(
        {
          id: saved.id,
          apiKeyId: saved.apiKeyId,
          from: saved.fromNumber,
          to: saved.toNumber,
          status: saved.status,
          metadata: saved.metadata,
          recordingUrl: saved.recordingUrl,
          createdAt: saved.createdAt.toISOString(),
          updatedAt: saved.updatedAt.toISOString(),
        },
        ttl,
      );
    } catch (err) {
      this.logger.warn(
        `Redis write failed for call ${saved.id} — state missing from cache until next write. Error: ${String(err)}`,
      );
    }

    // ── 3. Build response ────────────────────────────────────────────────────
    const wsBase = this.config.get('call', { infer: true }).wsPublicUrl;
    const websocket_url = `${wsBase}?callId=${saved.id}`;

    return { call_id: saved.id, websocket_url };
  }

  /**
   * Retrieve call state, preferring the Redis cache for speed.
   *
   * Ownership is enforced on both paths: a request for a call that belongs
   * to a different API key returns 404 (not 403) to avoid leaking existence.
   */
  async getCall(apiKey: RequestApiKey, id: string): Promise<CallResponse> {
    // ── Fast path: Redis ──────────────────────────────────────────────────────
    const state = await this.stateStore.read(id);
    if (state !== null) {
      if (state.apiKeyId !== apiKey.id) {
        // Do not reveal that the call exists under a different key.
        throw new NotFoundException(`Call ${id} not found`);
      }
      return callResponseFromState(state);
    }

    // ── Fallback: Postgres ────────────────────────────────────────────────────
    const entity = await this.callRepo.findOne({ where: { id, apiKeyId: apiKey.id } });
    if (!entity) {
      throw new NotFoundException(`Call ${id} not found`);
    }
    return callResponseFromEntity(entity);
  }
}
