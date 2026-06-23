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
});
