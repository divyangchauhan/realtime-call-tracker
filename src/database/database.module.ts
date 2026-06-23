import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'path';
import { Configuration } from '../config/configuration';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: (config: ConfigService<Configuration, true>) => {
        const db = config.get('database', { infer: true });
        return {
          type: 'postgres',
          host: db.host,
          port: db.port,
          username: db.username,
          password: db.password,
          database: db.name,
          synchronize: false,
          // Resolve to .ts files under ts-node and .js files under compiled dist
          entities: [join(__dirname, 'entities', '*.{ts,js}')],
          migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
          migrationsTableName: 'migrations',
          migrationsRun: db.runMigrations,
        };
      },
      inject: [ConfigService],
    }),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
