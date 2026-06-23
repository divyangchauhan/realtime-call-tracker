/**
 * Injection token for the ioredis COMMAND connection.
 * Used by CallStateStore and, in PR #5, the Lua rate-limiter.
 *
 * PR #5 will call client.defineCommand() on this client to load the Lua script.
 * PR #7/#9 will create SEPARATE subscriber/BullMQ connections — a Redis
 * connection in subscriber mode cannot issue normal commands.
 */
export const REDIS_CLIENT = 'REDIS_CLIENT';
