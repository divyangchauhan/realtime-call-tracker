/**
 * Standalone DataSource used by the TypeORM CLI (migration:run, migration:generate, etc.).
 * Not imported by the Nest application - the app uses TypeOrmModule.forRootAsync instead.
 */
import 'dotenv/config';
import { join } from 'path';
import { DataSource } from 'typeorm';

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
  username: process.env.POSTGRES_USER ?? 'calluser',
  password: process.env.POSTGRES_PASSWORD ?? 'callpass',
  database: process.env.POSTGRES_DB ?? 'calltracker',
  synchronize: false,
  entities: [join(__dirname, 'entities', '*.{ts,js}')],
  migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
  migrationsTableName: 'migrations',
});
