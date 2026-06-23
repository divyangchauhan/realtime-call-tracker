/**
 * Typed configuration factory loaded by ConfigModule.
 * Returns a structured object read from environment variables with sensible defaults.
 */

export interface Configuration {
  app: {
    port: number;
    nodeEnv: string;
  };
}

export default (): Configuration => ({
  app: {
    port: parseInt(process.env.PORT ?? '3000', 10),
    nodeEnv: process.env.NODE_ENV ?? 'development',
  },
});
