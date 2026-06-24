/**
 * Unit tests for CallsGateway.
 *
 * Strategy:
 *  - No real WebSocket server or Redis connection is started.
 *  - Mock socket objects:   { send: jest.fn(), close: jest.fn(), readyState: 1 }
 *    (readyState 1 = OPEN, matching ws.WebSocket.OPEN).
 *  - Mock subscriber:       { subscribe: jest.fn(), unsubscribe: jest.fn(), on: jest.fn() }
 *  - Mock CallStateStore:   { read: jest.fn() }
 *  - The gateway registers a 'message' handler via subscriber.on('message', handler).
 *    Tests capture that handler and invoke it directly to simulate Redis pub/sub
 *    events without needing a real ioredis subscriber.
 *
 * All method calls are made directly on the CallsGateway instance; the NestJS
 * WebSocket adapter is NOT involved.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { IncomingMessage } from 'http';
import { REDIS_SUBSCRIBER } from '../redis/redis.constants';
import { CallStateStore } from '../calls/call-state.store';
import { CallStatus } from '../database/entities/call-status.enum';
import { CallState } from '../calls/call-state.store';
import { CALL_EVENTS_CHANNEL } from '../calls/call-events.constants';
import { CallsGateway } from './calls.gateway';

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** readyState 1 = WebSocket.OPEN */
const WS_OPEN = 1;
/** readyState 3 = WebSocket.CLOSED */
const WS_CLOSED = 3;

/** Factory for a mock WebSocket with configurable readyState. */
function makeMockSocket(readyState = WS_OPEN) {
  return {
    send: jest.fn(),
    close: jest.fn(),
    readyState,
  };
}

/** Factory for a minimal CallState object. */
function makeCallState(id = 'call-aaa'): CallState {
  return {
    id,
    apiKeyId: 'key-1',
    from: '+15550001111',
    to: '+15550002222',
    status: CallStatus.QUEUED,
    metadata: null,
    recordingUrl: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

/** Build a fake IncomingMessage with the given URL path+query. */
function makeRequest(url: string): IncomingMessage {
  return { url } as IncomingMessage;
}

/** Build the JSON payload that CallProgressionService publishes. */
function makePayload(id: string, status: CallStatus = CallStatus.RINGING): string {
  return JSON.stringify({
    id,
    from: '+15550001111',
    to: '+15550002222',
    status,
    metadata: null,
    recording_url: null,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:01.000Z',
  });
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('CallsGateway', () => {
  let gateway: CallsGateway;
  let subscriberMock: {
    subscribe: jest.Mock;
    unsubscribe: jest.Mock;
    on: jest.Mock;
  };
  let stateStoreMock: { read: jest.Mock };

  /**
   * Capture the 'message' handler the gateway registered via subscriber.on().
   * Calling this simulates a Redis pub/sub message delivery.
   */
  let messageHandler: (channel: string, message: string) => void;

  beforeEach(async () => {
    subscriberMock = {
      subscribe: jest.fn().mockResolvedValue(undefined),
      unsubscribe: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    };

    stateStoreMock = {
      read: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CallsGateway,
        { provide: REDIS_SUBSCRIBER, useValue: subscriberMock },
        { provide: CallStateStore, useValue: stateStoreMock },
      ],
    }).compile();

    gateway = module.get<CallsGateway>(CallsGateway);

    // Initialise the gateway so it calls subscriber.subscribe() and registers
    // the 'message' listener.
    gateway.onModuleInit();

    // Extract the handler registered via subscriber.on('message', handler).
    const onCall = subscriberMock.on.mock.calls.find((args: unknown[]) => args[0] === 'message');
    expect(onCall).toBeDefined();
    messageHandler = onCall![1] as (channel: string, message: string) => void;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── onModuleInit ────────────────────────────────────────────────────────────

  describe('onModuleInit', () => {
    it('subscribes to the call:events channel', () => {
      expect(subscriberMock.subscribe).toHaveBeenCalledWith(CALL_EVENTS_CHANNEL);
    });

    it('registers a message listener on the subscriber', () => {
      expect(subscriberMock.on).toHaveBeenCalledWith('message', expect.any(Function));
    });
  });

  // ── handleConnection — missing callId ──────────────────────────────────────

  describe('handleConnection — missing callId', () => {
    it('closes the socket with 1008 when callId is absent', () => {
      const socket = makeMockSocket();
      gateway.handleConnection(socket as any, makeRequest('/ws'));

      expect(socket.close).toHaveBeenCalledWith(1008, 'callId query param required');
      expect(socket.send).not.toHaveBeenCalled();
    });

    it('closes the socket with 1008 when callId is blank', () => {
      const socket = makeMockSocket();
      gateway.handleConnection(socket as any, makeRequest('/ws?callId='));

      expect(socket.close).toHaveBeenCalledWith(1008, 'callId query param required');
    });

    it('closes the socket with 1008 when callId is whitespace-only (trimmed to empty)', () => {
      const socket = makeMockSocket();
      gateway.handleConnection(socket as any, makeRequest('/ws?callId=%20%20%20'));

      expect(socket.close).toHaveBeenCalledWith(1008, 'callId query param required');
    });

    it('does NOT register a socket with a missing callId', async () => {
      const socket = makeMockSocket();
      gateway.handleConnection(socket as any, makeRequest('/ws'));

      // Drive a message for a random callId — should not reach the rejected socket.
      messageHandler(CALL_EVENTS_CHANNEL, makePayload('some-call'));

      // Flush any pending microtasks.
      await Promise.resolve();

      expect(socket.send).not.toHaveBeenCalled();
    });
  });

  // ── handleConnection — valid callId ────────────────────────────────────────

  describe('handleConnection — valid callId', () => {
    it('does NOT close the socket when callId is valid', () => {
      const socket = makeMockSocket();
      gateway.handleConnection(socket as any, makeRequest('/ws?callId=call-aaa'));

      expect(socket.close).not.toHaveBeenCalled();
    });

    it('sends a snapshot immediately when CallStateStore.read returns state', async () => {
      const state = makeCallState('call-aaa');
      stateStoreMock.read.mockResolvedValue(state);

      const socket = makeMockSocket();
      gateway.handleConnection(socket as any, makeRequest('/ws?callId=call-aaa'));

      // Wait for the async snapshot read to resolve.
      await Promise.resolve();
      await Promise.resolve(); // extra tick for the catch-wrapper

      expect(stateStoreMock.read).toHaveBeenCalledWith('call-aaa');
      expect(socket.send).toHaveBeenCalledTimes(1);

      const sent = JSON.parse(socket.send.mock.calls[0][0] as string) as Record<string, unknown>;
      expect(sent['id']).toBe('call-aaa');
      expect(sent['status']).toBe(CallStatus.QUEUED);
      expect(sent['recording_url']).toBeNull(); // snake_case shape
    });

    it('sends NO snapshot when CallStateStore.read returns null', async () => {
      stateStoreMock.read.mockResolvedValue(null);

      const socket = makeMockSocket();
      gateway.handleConnection(socket as any, makeRequest('/ws?callId=call-aaa'));

      await Promise.resolve();
      await Promise.resolve();

      expect(socket.send).not.toHaveBeenCalled();
    });

    it('does NOT send the snapshot if the socket closed during the async read', async () => {
      stateStoreMock.read.mockResolvedValue(makeCallState('call-aaa'));

      // Socket is OPEN at connect time but transitions to CLOSED before the
      // async stateStore.read resolves — the snapshot send must be skipped.
      const socket = makeMockSocket();
      gateway.handleConnection(socket as any, makeRequest('/ws?callId=call-aaa'));
      socket.readyState = WS_CLOSED;

      await Promise.resolve();
      await Promise.resolve();

      expect(stateStoreMock.read).toHaveBeenCalledWith('call-aaa');
      expect(socket.send).not.toHaveBeenCalled();
    });
  });

  // ── Fan-out isolation ──────────────────────────────────────────────────────

  describe('fan-out isolation', () => {
    it('delivers a call:events message ONLY to clients registered for that callId', async () => {
      const socketA = makeMockSocket();
      const socketB = makeMockSocket();

      gateway.handleConnection(socketA as any, makeRequest('/ws?callId=call-aaa'));
      gateway.handleConnection(socketB as any, makeRequest('/ws?callId=call-bbb'));

      const payload = makePayload('call-aaa');
      messageHandler(CALL_EVENTS_CHANNEL, payload);

      // socketA (call-aaa) should receive the message.
      expect(socketA.send).toHaveBeenCalledWith(payload);
      // socketB (call-bbb) must NOT receive a message for call-aaa.
      expect(socketB.send).not.toHaveBeenCalled();
    });

    it('delivers to ALL clients registered for the same callId', () => {
      const socket1 = makeMockSocket();
      const socket2 = makeMockSocket();

      gateway.handleConnection(socket1 as any, makeRequest('/ws?callId=call-aaa'));
      gateway.handleConnection(socket2 as any, makeRequest('/ws?callId=call-aaa'));

      const payload = makePayload('call-aaa', CallStatus.RINGING);
      messageHandler(CALL_EVENTS_CHANNEL, payload);

      expect(socket1.send).toHaveBeenCalledWith(payload);
      expect(socket2.send).toHaveBeenCalledWith(payload);
    });

    it('does NOT deliver messages for unknown callIds (no registered clients)', () => {
      const socket = makeMockSocket();
      gateway.handleConnection(socket as any, makeRequest('/ws?callId=call-aaa'));

      // Publish an event for a completely different call.
      messageHandler(CALL_EVENTS_CHANNEL, makePayload('call-zzz'));

      expect(socket.send).not.toHaveBeenCalled();
    });
  });

  // ── readyState guard ───────────────────────────────────────────────────────

  describe('readyState guard', () => {
    it('skips a socket whose readyState is not OPEN', () => {
      const closedSocket = makeMockSocket(WS_CLOSED);
      const openSocket = makeMockSocket(WS_OPEN);

      gateway.handleConnection(closedSocket as any, makeRequest('/ws?callId=call-aaa'));
      gateway.handleConnection(openSocket as any, makeRequest('/ws?callId=call-aaa'));

      const payload = makePayload('call-aaa');
      messageHandler(CALL_EVENTS_CHANNEL, payload);

      // CLOSED socket must be skipped.
      expect(closedSocket.send).not.toHaveBeenCalled();
      // OPEN socket must receive the message.
      expect(openSocket.send).toHaveBeenCalledWith(payload);
    });

    it('does not stop delivery to other clients when one send() throws', () => {
      const badSocket = makeMockSocket();
      badSocket.send.mockImplementation(() => {
        throw new Error('write EPIPE');
      });
      const goodSocket = makeMockSocket();

      gateway.handleConnection(badSocket as any, makeRequest('/ws?callId=call-aaa'));
      gateway.handleConnection(goodSocket as any, makeRequest('/ws?callId=call-aaa'));

      const payload = makePayload('call-aaa');

      // Must not throw even though badSocket.send() throws.
      expect(() => messageHandler(CALL_EVENTS_CHANNEL, payload)).not.toThrow();

      // goodSocket must still receive the message.
      expect(goodSocket.send).toHaveBeenCalledWith(payload);
    });
  });

  // ── handleDisconnect ───────────────────────────────────────────────────────

  describe('handleDisconnect', () => {
    it('removes the client so subsequent events are not sent to it', () => {
      const socket = makeMockSocket();
      gateway.handleConnection(socket as any, makeRequest('/ws?callId=call-aaa'));

      // Disconnect the client.
      gateway.handleDisconnect(socket as any);

      // Now publish an event for call-aaa.
      messageHandler(CALL_EVENTS_CHANNEL, makePayload('call-aaa'));

      // The disconnected socket should receive nothing.
      expect(socket.send).not.toHaveBeenCalled();
    });

    it('cleans up the callId entry when the last client disconnects', () => {
      const socket = makeMockSocket();
      gateway.handleConnection(socket as any, makeRequest('/ws?callId=call-aaa'));
      gateway.handleDisconnect(socket as any);

      // The map entry should be gone — no error thrown on subsequent publish.
      expect(() => messageHandler(CALL_EVENTS_CHANNEL, makePayload('call-aaa'))).not.toThrow();
    });

    it('keeps remaining clients after only one of two disconnects', () => {
      const socket1 = makeMockSocket();
      const socket2 = makeMockSocket();

      gateway.handleConnection(socket1 as any, makeRequest('/ws?callId=call-aaa'));
      gateway.handleConnection(socket2 as any, makeRequest('/ws?callId=call-aaa'));

      // Disconnect only socket1.
      gateway.handleDisconnect(socket1 as any);

      const payload = makePayload('call-aaa');
      messageHandler(CALL_EVENTS_CHANNEL, payload);

      // socket1 must be gone.
      expect(socket1.send).not.toHaveBeenCalled();
      // socket2 must still receive events.
      expect(socket2.send).toHaveBeenCalledWith(payload);
    });

    it('is a no-op when called for a socket that was never registered', () => {
      const neverRegistered = makeMockSocket();
      // Must not throw.
      expect(() => gateway.handleDisconnect(neverRegistered as any)).not.toThrow();
    });
  });

  // ── Malformed / incomplete payloads ───────────────────────────────────────

  describe('malformed / incomplete payloads', () => {
    it('does not throw on non-JSON payload', () => {
      const socket = makeMockSocket();
      gateway.handleConnection(socket as any, makeRequest('/ws?callId=call-aaa'));

      expect(() => messageHandler(CALL_EVENTS_CHANNEL, 'this is not json')).not.toThrow();

      expect(socket.send).not.toHaveBeenCalled();
    });

    it('does not throw and sends nothing when payload lacks "id" field', () => {
      const socket = makeMockSocket();
      gateway.handleConnection(socket as any, makeRequest('/ws?callId=call-aaa'));

      const noId = JSON.stringify({ status: 'RINGING', from: '+1', to: '+2' });
      expect(() => messageHandler(CALL_EVENTS_CHANNEL, noId)).not.toThrow();

      expect(socket.send).not.toHaveBeenCalled();
    });
  });

  // ── onModuleDestroy ────────────────────────────────────────────────────────

  describe('onModuleDestroy', () => {
    it('unsubscribes from the call:events channel', () => {
      gateway.onModuleDestroy();
      expect(subscriberMock.unsubscribe).toHaveBeenCalledWith(CALL_EVENTS_CHANNEL);
    });

    it('closes all connected sockets on destroy', () => {
      const socket1 = makeMockSocket();
      const socket2 = makeMockSocket();

      gateway.handleConnection(socket1 as any, makeRequest('/ws?callId=call-aaa'));
      gateway.handleConnection(socket2 as any, makeRequest('/ws?callId=call-bbb'));

      gateway.onModuleDestroy();

      expect(socket1.close).toHaveBeenCalledWith(1001, 'Server shutting down');
      expect(socket2.close).toHaveBeenCalledWith(1001, 'Server shutting down');
    });

    it('no longer delivers events after destroy (maps cleared)', () => {
      const socket = makeMockSocket();
      gateway.handleConnection(socket as any, makeRequest('/ws?callId=call-aaa'));

      gateway.onModuleDestroy();

      // Publishing after destroy must not throw and must not reach the socket.
      expect(() => messageHandler(CALL_EVENTS_CHANNEL, makePayload('call-aaa'))).not.toThrow();

      // socket.send was not called (close was called, not send).
      expect(socket.send).not.toHaveBeenCalled();
    });
  });
});
