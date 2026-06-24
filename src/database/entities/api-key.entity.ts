import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('api_keys')
export class ApiKey {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Human-readable label for this key (e.g. "dev", "production"). */
  @Column({ type: 'varchar' })
  name!: string;

  /**
   * SHA-256 hex digest of the raw API key.
   * The auth guard re-hashes the incoming Bearer token and looks this up.
   */
  @Column({ type: 'varchar', unique: true, name: 'key_hash' })
  keyHash!: string;

  /** Maximum simultaneous in-progress calls allowed for this key. */
  @Column({ type: 'int', name: 'max_concurrent' })
  maxConcurrent!: number;

  /** Maximum new calls per second allowed for this key. */
  @Column({ type: 'int', name: 'max_cps' })
  maxCps!: number;

  @Column({ type: 'boolean', name: 'is_active', default: true })
  isActive!: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
