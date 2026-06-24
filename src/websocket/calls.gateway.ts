import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from '@nestjs/websockets';
import { IncomingMessage } from 'http';
import Redis from 'ioredis';
import { WebSocket } from 'ws';
import { CALL_EVENTS_CHANNEL } from '../calls/call-events.constants';
import { CallStateStore } from '../calls/call-state.store';
import { callResponseFromState } from '../calls/dto/call-response.dto';
import { REDIS_SUBSCRIBER } from '../redis/redis.constants';

/**
 * WebSocket gateway that streams live call-state transitions to subscribed
 * clients.
 *
 * Connection URL:  ws://<host>:3000/ws?callId=<uuid>
 *
 * This is exactly the `websocket_url` value returned by POST /calls.
 *
 * ── Authentication note ───────────────────────────────────────────────────────
 * The WS connection authenticates by capability: the `callId` is an
 * unguessable UUID handed back from an authenticated POST /calls (which
 * requires a valid Bearer API key). No additional bearer auth is needed on the
 * socket itself — possession of the callId proves prior authentication.
 * Isolation is guaranteed by routing: only events whose `id` matches a
 * client's registered `callId` are ever forwarded to that client, so callers
 * can never observe each other's calls.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Fan-out design:
 *  - A single Redis SUBSCRIBER connection (distinct from REDIS_CLIENT) listens
 *    on the `call:events` channel.  CallProgressionService (PR #6) PUBLISHes
 *    the public JSON payload on every state transition.
 *  - Per-callId routing is maintained via two maps:
 *      callClients:  Map<callId, Set<WebSocket>>  — forward-lookup for fan-out
 *      clientCallId: Map<WebSocket, callId>       — reverse-lookup for O(1) disconnect
 *  - On each incoming pub/sub message the gateway parses the `id` field and
 *    fans the raw payload string to every socket in callClients.get(id).
 *  - Only sockets in OPEN state receive messages; bad sockets are skipped and
 *    their send() errors are swallowed so one broken socket cannot break others.
 */
@Injectable()
@WebSocketGateway({ path: '/ws' })
export class CallsGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(CallsGateway.name);

  /**
   * Forward lookup: callId → set of connected WebSocket clients for that call.
   * Used during fan-out to find all sockets interested in a given event.
   */
  private readonly callClients = new Map<string, Set<WebSocket>>();

  /**
   * Reverse lookup: WebSocket → callId it is subscribed to.
   * Used in handleDisconnect to locate and remove the socket from callClients
   * in O(1) without iterating all entries.
   */
  private readonly clientCallId = new Map<WebSocket, string>();

  constructor(
    /**
     * The dedicated subscriber connection.  Must be separate from REDIS_CLIENT
     * because a connection in subscriber mode cannot issue normal commands.
     * Provided by RedisModule (@Global()), so no explicit import is needed.
     */
    @Inject(REDIS_SUBSCRIBER) private readonly subscriber: Redis,
    /**
     * Used to read the current call snapshot on connect so a late joiner
     * immediately receives the latest state without waiting for the next
     * transition event.
     */
    private readonly stateStore: CallStateStore,
  ) {}

  // ── Lifecycle: module init ──────────────────────────────────────────────────

  /**
   * Subscribe to the call:events channel and register the fan-out handler.
   *
   * Called once when the DI container finishes wiring all providers.  At this
   * point the REDIS_SUBSCRIBER connection is already open (lazyConnect: false).
   * ioredis will automatically re-subscribe to the channel after any reconnect.
   */
  onModuleInit(): void {
    // Subscribe returns a promise; we fire-and-forget but log any errors.
    this.subscriber.subscribe(CALL_EVENTS_CHANNEL).catch((err: unknown) => {
      this.logger.error(`Failed to subscribe to ${CALL_EVENTS_CHANNEL}: ${String(err)}`);
    });

    // 'message' fires for every PUBLISH on any subscribed channel.
    // The handler is intentionally synchronous so it is called directly by the
    // ioredis event loop without needing Promise handling in the listener.
    this.subscriber.on('message', (channel: string, message: string) => {
      this.handleRedisMessage(channel, message);
    });

    this.logger.log(`Subscribed to Redis channel: ${CALL_EVENTS_CHANNEL}`);
  }

  // ── Lifecycle: module destroy ───────────────────────────────────────────────

  /**
   * Unsubscribe from Redis and close all connected WebSocket clients.
   *
   * The REDIS_SUBSCRIBER connection itself is quit by RedisSubscriberLifecycleHost
   * in RedisModule.  We only need to unsubscribe the channel and close sockets.
   */
  onModuleDestroy(): void {
    // Unsubscribe from the channel (fire-and-forget on shutdown).
    this.subscriber.unsubscribe(CALL_EVENTS_CHANNEL).catch((err: unknown) => {
      this.logger.warn(
        `Error unsubscribing from ${CALL_EVENTS_CHANNEL} on destroy: ${String(err)}`,
      );
    });

    // Close all connected sockets so clients receive a clean CLOSE frame.
    let closedCount = 0;
    for (const [, sockets] of this.callClients) {
      for (const ws of sockets) {
        try {
          ws.close(1001, 'Server shutting down');
          closedCount++;
        } catch (err) {
          this.logger.warn(`Error closing socket on destroy: ${String(err)}`);
        }
      }
    }

    this.callClients.clear();
    this.clientCallId.clear();

    if (closedCount > 0) {
      this.logger.log(`Closed ${closedCount} WebSocket connection(s) on module destroy`);
    }
  }

  // ── WebSocket: client connects ─────────────────────────────────────────────

  /**
   * Called by the NestJS WebSocket adapter when a new client connects.
   *
   * @param client  - The ws.WebSocket instance for this connection.
   * @param request - The raw http.IncomingMessage (includes the query string).
   *
   * Flow:
   *  1. Parse `callId` from the URL query string.
   *  2. Reject (close with 1008 Policy Violation) if callId is missing/blank.
   *  3. Register the socket in both maps.
   *  4. Read the current call state from Redis and send a snapshot to the client
   *     so a late joiner is not blind until the next progression transition.
   */
  handleConnection(client: WebSocket, request: IncomingMessage): void {
    // The URL field on IncomingMessage is path-only (no host), so we supply a
    // dummy base to satisfy the URL constructor.
    const url = new URL(request.url ?? '', 'http://localhost');
    const callId = url.searchParams.get('callId')?.trim() ?? '';

    if (!callId) {
      // Close with 1008 Policy Violation — the callId is mandatory.
      // Return immediately so this socket is never registered.
      this.logger.warn('WebSocket connection rejected: missing callId query param');
      client.close(1008, 'callId query param required');
      return;
    }

    // ── Register socket ─────────────────────────────────────────────────────
    if (!this.callClients.has(callId)) {
      this.callClients.set(callId, new Set());
    }
    this.callClients.get(callId)!.add(client);
    this.clientCallId.set(client, callId);

    this.logger.log(
      `Client connected for callId=${callId} ` +
        `(total=${this.callClients.get(callId)!.size} for this call)`,
    );

    // ── Send initial snapshot (async, fire-and-forget) ───────────────────────
    // Reading from Redis is async; we must not block handleConnection.  Any
    // error is logged and swallowed — the client will receive events on the
    // next transition anyway.
    this.sendSnapshot(client, callId).catch((err: unknown) => {
      this.logger.warn(`Failed to send snapshot for callId=${callId}: ${String(err)}`);
    });
  }

  // ── WebSocket: client disconnects ──────────────────────────────────────────

  /**
   * Called by the NestJS WebSocket adapter when a client disconnects.
   *
   * Uses the reverse clientCallId map to find the callId in O(1), then removes
   * the socket from the forward callClients map and deletes the Set entry when
   * it becomes empty.
   */
  handleDisconnect(client: WebSocket): void {
    const callId = this.clientCallId.get(client);
    if (!callId) {
      // Socket was rejected before registration (e.g. missing callId).
      return;
    }

    // Remove from reverse map.
    this.clientCallId.delete(client);

    // Remove from forward map.
    const sockets = this.callClients.get(callId);
    if (sockets) {
      sockets.delete(client);
      if (sockets.size === 0) {
        // No more clients watching this call — free the Set.
        this.callClients.delete(callId);
      }
    }

    this.logger.log(`Client disconnected for callId=${callId}`);
  }

  // ── Internal: Redis pub/sub handler ────────────────────────────────────────

  /**
   * Called for every message received on the subscribed Redis channel.
   *
   * Parses the JSON payload, extracts `id`, and fans the raw message string
   * out to all connected clients registered for that callId.
   *
   * Design decisions:
   *  - We fan out the RAW string (not re-serialised) so the gateway is a
   *    transparent forwarder; no risk of introducing serialisation drift.
   *  - Only OPEN sockets receive the message (readyState === WebSocket.OPEN === 1).
   *  - Each send() is wrapped in try/catch so one broken socket cannot
   *    prevent delivery to the remaining clients for that call.
   *  - Malformed JSON or a payload missing `id` is logged as a warning and
   *    skipped — the gateway must never throw from inside an event listener.
   */
  private handleRedisMessage(channel: string, message: string): void {
    // We only subscribe to CALL_EVENTS_CHANNEL, but guard defensively.
    if (channel !== CALL_EVENTS_CHANNEL) {
      return;
    }

    // ── Parse payload ────────────────────────────────────────────────────────
    let parsed: { id?: string } | null = null;
    try {
      parsed = JSON.parse(message) as { id?: string };
    } catch {
      this.logger.warn(
        `Received malformed JSON on ${CALL_EVENTS_CHANNEL}; skipping. ` +
          `Raw: ${message.slice(0, 200)}`,
      );
      return;
    }

    const callId = parsed?.id;
    if (!callId) {
      this.logger.warn(`Received payload missing "id" field on ${CALL_EVENTS_CHANNEL}; skipping.`);
      return;
    }

    // ── Fan-out ──────────────────────────────────────────────────────────────
    const sockets = this.callClients.get(callId);
    if (!sockets || sockets.size === 0) {
      // No clients watching this call — nothing to do.
      return;
    }

    for (const ws of sockets) {
      if (ws.readyState !== WebSocket.OPEN) {
        // Socket is closing or already closed; skip without logging noise.
        continue;
      }
      try {
        ws.send(message);
      } catch (err) {
        // One broken socket must not stop delivery to the others.
        this.logger.warn(`Failed to send to a client for callId=${callId}: ${String(err)}`);
      }
    }
  }

  // ── Internal: initial snapshot ─────────────────────────────────────────────

  /**
   * Read the current call state from Redis and send it to the newly-connected
   * client as their first message.
   *
   * This ensures that a late joiner (e.g. client connects after RINGING has
   * already been published) immediately receives the up-to-date state rather
   * than waiting for the next transition event.
   *
   * If no state is found in Redis (call not yet written, or TTL expired) we
   * simply send nothing — the client will receive events normally going forward.
   *
   * ORDERING CONTRACT: because this snapshot read is async, a live transition
   * event PUBLISHed during the read can reach the client BEFORE this snapshot,
   * so the client may briefly observe a newer status followed by the older
   * snapshot. Clients MUST therefore treat `updated_at` as the ordering key and
   * ignore any message whose `updated_at` is not newer than the latest they have
   * already applied. (Statuses are also strictly forward-only, so a client may
   * equivalently ignore a backwards status transition.)
   */
  private async sendSnapshot(client: WebSocket, callId: string): Promise<void> {
    const state = await this.stateStore.read(callId);
    if (!state) {
      // No cached state — possibly not yet written or already expired.
      this.logger.debug(`No Redis snapshot found for callId=${callId}; skipping initial send`);
      return;
    }

    // readyState check: the client could have disconnected between handleConnection
    // and this async read completing.
    if (client.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      client.send(JSON.stringify(callResponseFromState(state)));
      this.logger.debug(`Sent snapshot for callId=${callId}`);
    } catch (err) {
      this.logger.warn(`Failed to send snapshot to client for callId=${callId}: ${String(err)}`);
    }
  }
}
