import { Call } from '../../database/entities/call.entity';
import { CallStatus } from '../../database/entities/call-status.enum';
import { CallState } from '../call-state.store';

/**
 * Snake-case JSON shape returned by GET /calls/:id.
 * Both the Redis fast-path and the Postgres fallback produce this identical shape.
 */
export interface CallResponse {
  id: string;
  from: string;
  to: string;
  status: CallStatus;
  metadata: Record<string, unknown> | null;
  recording_url: string | null;
  created_at: string;
  updated_at: string;
}

/** Map a Redis CallState (already in string form) to the response shape. */
export function callResponseFromState(state: CallState): CallResponse {
  return {
    id: state.id,
    from: state.from,
    to: state.to,
    status: state.status,
    metadata: state.metadata,
    recording_url: state.recordingUrl,
    created_at: state.createdAt,
    updated_at: state.updatedAt,
  };
}

/** Map a TypeORM Call entity to the response shape. */
export function callResponseFromEntity(entity: Call): CallResponse {
  return {
    id: entity.id,
    from: entity.fromNumber,
    to: entity.toNumber,
    status: entity.status,
    metadata: entity.metadata,
    recording_url: entity.recordingUrl,
    created_at: entity.createdAt.toISOString(),
    updated_at: entity.updatedAt.toISOString(),
  };
}
