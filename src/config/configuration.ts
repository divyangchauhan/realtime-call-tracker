/**
 * Typed configuration factory loaded by ConfigModule.
 * Returns a structured object read from environment variables with sensible defaults.
 */

export interface Configuration {
  app: {
    port: number;
    nodeEnv: string;
  };
  database: {
    host: string;
    port: number;
    username: string;
    password: string;
    name: string;
    runMigrations: boolean;
  };
  redis: {
    host: string;
    port: number;
  };
  call: {
    /** Seconds to keep live call state in Redis. Default 3600 (1 hour). */
    stateTtlSeconds: number;
    /**
     * Public WebSocket base URL advertised to callers.
     * PR #7 will stand up the actual gateway at this address.
     */
    wsPublicUrl: string;
  };
}

export default (): Configuration => ({
  app: {
    port: parseInt(process.env.PORT ?? '3000', 10),
    nodeEnv: process.env.NODE_ENV ?? 'development',
  },
  database: {
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
    username: process.env.POSTGRES_USER ?? 'calluser',
    password: process.env.POSTGRES_PASSWORD ?? 'callpass',
    name: process.env.POSTGRES_DB ?? 'calltracker',
    runMigrations: (process.env.DB_RUN_MIGRATIONS ?? 'true') !== 'false',
  },
  redis: {
    host: process.env.REDIS_HOST ?? 'redis',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  },
  call: {
    stateTtlSeconds: parseInt(process.env.CALL_STATE_TTL_SECONDS ?? '3600', 10),
    wsPublicUrl: process.env.WS_PUBLIC_URL ?? 'ws://localhost:3000/ws',
  },
});
