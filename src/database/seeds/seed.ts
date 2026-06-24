/**
 * Dev seed - run with: pnpm seed
 *
 * Idempotently upserts a single dev API key into api_keys.
 * The raw key is printed to stdout so the developer can use it immediately
 * as a Bearer token.
 */
import 'dotenv/config';
import { AppDataSource } from '../data-source';
import { ApiKey } from '../entities/api-key.entity';
import { hashApiKey } from '../../common/crypto.util';

const RAW_KEY = process.env.SEED_API_KEY ?? 'dev-secret-key';

async function seed(): Promise<void> {
  await AppDataSource.initialize();

  const repo = AppDataSource.getRepository(ApiKey);
  const keyHash = hashApiKey(RAW_KEY);

  const existing = await repo.findOneBy({ keyHash });

  if (existing) {
    // Idempotent: update rate limits in case they changed, but don't re-insert
    await repo.update(existing.id, { maxConcurrent: 3, maxCps: 2, isActive: true });
    console.log(`[seed] Key already exists (id=${existing.id}), limits refreshed.`);
  } else {
    const key = repo.create({
      name: 'dev',
      keyHash,
      maxConcurrent: 3,
      maxCps: 2,
      isActive: true,
    });
    await repo.save(key);
    console.log(`[seed] Created new dev API key (id=${key.id}).`);
  }

  console.log('');
  console.log(`Raw key     : ${RAW_KEY}`);
  console.log(`Authorization: Bearer ${RAW_KEY}`);
  console.log('');

  await AppDataSource.destroy();
  process.exit(0);
}

seed().catch((err: unknown) => {
  console.error('[seed] Fatal error:', err);
  void AppDataSource.destroy().finally(() => process.exit(1));
});
