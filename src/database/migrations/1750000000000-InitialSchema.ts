import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1750000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Enable pgcrypto for gen_random_uuid()
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    // Enum type for call status
    await queryRunner.query(`
      CREATE TYPE "calls_status_enum" AS ENUM (
        'QUEUED',
        'RINGING',
        'ANSWERED',
        'UNANSWERED',
        'COMPLETED'
      )
    `);

    // api_keys table
    await queryRunner.query(`
      CREATE TABLE "api_keys" (
        "id"             UUID        NOT NULL DEFAULT gen_random_uuid(),
        "name"           VARCHAR     NOT NULL,
        "key_hash"       VARCHAR     NOT NULL,
        "max_concurrent" INTEGER     NOT NULL,
        "max_cps"        INTEGER     NOT NULL,
        "is_active"      BOOLEAN     NOT NULL DEFAULT true,
        "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_api_keys" PRIMARY KEY ("id")
      )
    `);

    // Unique index on key_hash (also enforces the UNIQUE constraint)
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_api_keys_key_hash" ON "api_keys" ("key_hash")
    `);

    // calls table
    await queryRunner.query(`
      CREATE TABLE "calls" (
        "id"            UUID                 NOT NULL DEFAULT gen_random_uuid(),
        "api_key_id"    UUID                 NOT NULL,
        "from_number"   VARCHAR              NOT NULL,
        "to_number"     VARCHAR              NOT NULL,
        "status"        "calls_status_enum"  NOT NULL DEFAULT 'QUEUED',
        "metadata"      JSONB,
        "recording_url" VARCHAR,
        "created_at"    TIMESTAMPTZ          NOT NULL DEFAULT now(),
        "updated_at"    TIMESTAMPTZ          NOT NULL DEFAULT now(),
        "completed_at"  TIMESTAMPTZ,
        CONSTRAINT "PK_calls" PRIMARY KEY ("id"),
        CONSTRAINT "FK_calls_api_key_id"
          FOREIGN KEY ("api_key_id") REFERENCES "api_keys" ("id")
          ON DELETE RESTRICT
      )
    `);

    // Indexes on calls
    await queryRunner.query(`
      CREATE INDEX "IDX_calls_status" ON "calls" ("status")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_calls_api_key_id" ON "calls" ("api_key_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_calls_created_at" ON "calls" ("created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop indexes on calls
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_calls_created_at"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_calls_api_key_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_calls_status"`);

    // Drop calls table (references api_keys via FK, so drop first)
    await queryRunner.query(`DROP TABLE IF EXISTS "calls"`);

    // Drop api_keys unique index and table
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_api_keys_key_hash"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "api_keys"`);

    // Drop the enum type
    await queryRunner.query(`DROP TYPE IF EXISTS "calls_status_enum"`);
  }
}
