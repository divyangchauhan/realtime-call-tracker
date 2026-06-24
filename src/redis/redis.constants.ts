/**
 * Injection token for the ioredis COMMAND connection.
 * Used by CallStateStore and, in PR #5, the Lua rate-limiter.
 *
 * PR #5 will call client.defineCommand() on this client to load the Lua script.
 * PR #7/#9 will create SEPARATE subscriber/BullMQ connections — a Redis
 * connection in subscriber mode cannot issue normal commands.
 */
export const REDIS_CLIENT = 'REDIS_CLIENT';

/**
 * Injection token for the dedicated ioredis SUBSCRIBER connection.
 *
 * A Redis connection placed in subscriber mode (via SUBSCRIBE / PSUBSCRIBE)
 * cannot issue normal commands (GET, SET, HSET, …); the two connection types
 * MUST be separate.  This token is provided by RedisModule (which is @Global())
 * and consumed by WebsocketModule's CallsGateway (PR #7).
 *
 * PR #9 (BullMQ) will add a third, separate connection for queue work.
 */
export const REDIS_SUBSCRIBER = 'REDIS_SUBSCRIBER';
