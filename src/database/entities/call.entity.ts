import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ApiKey } from './api-key.entity';
import { CallStatus } from './call-status.enum';

@Entity('calls')
export class Call {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'api_key_id', nullable: false })
  apiKeyId!: string;

  @ManyToOne(() => ApiKey, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'api_key_id' })
  apiKey!: ApiKey;

  @Column({ type: 'varchar', name: 'from_number' })
  fromNumber!: string;

  @Column({ type: 'varchar', name: 'to_number' })
  toNumber!: string;

  /**
   * Postgres enum type calls_status_enum.
   * Driven by the auto-progression state machine.
   */
  @Column({
    type: 'enum',
    enum: CallStatus,
    enumName: 'calls_status_enum',
    default: CallStatus.QUEUED,
  })
  status!: CallStatus;

  /** Arbitrary caller-supplied metadata stored as JSON. */
  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  /**
   * S3 URL written back by the BullMQ recording worker.
   */
  @Column({ type: 'varchar', name: 'recording_url', nullable: true })
  recordingUrl!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @Column({ type: 'timestamptz', name: 'completed_at', nullable: true })
  completedAt!: Date | null;
}
