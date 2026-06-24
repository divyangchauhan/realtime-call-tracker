import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { RequestApiKey } from '../auth/auth.types';
import { CurrentApiKey } from '../auth/current-api-key.decorator';
import { CallsService, CreateCallResult } from './calls.service';
import { CreateCallDto } from './dto/create-call.dto';
import { CallResponse } from './dto/call-response.dto';

/**
 * Handles /calls endpoints.
 * Authentication is applied globally by ApiKeyAuthGuard.
 */
@Controller('calls')
export class CallsController {
  constructor(private readonly callsService: CallsService) {}

  /**
   * POST /calls
   * Creates a new call record (QUEUED) and returns a WebSocket URL for tracking.
   */
  @Post()
  @HttpCode(201)
  async createCall(
    @Body() dto: CreateCallDto,
    @CurrentApiKey() apiKey: RequestApiKey,
  ): Promise<CreateCallResult> {
    return this.callsService.createCall(apiKey, dto);
  }

  /**
   * GET /calls/:id
   * Returns live call state (Redis-first, Postgres fallback).
   * A malformed UUID short-circuits to 400 via ParseUUIDPipe.
   * A call belonging to a different API key returns 404.
   */
  @Get(':id')
  async getCall(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentApiKey() apiKey: RequestApiKey,
  ): Promise<CallResponse> {
    return this.callsService.getCall(apiKey, id);
  }
}
