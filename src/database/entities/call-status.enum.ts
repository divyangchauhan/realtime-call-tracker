/**
 * Postgres enum type: calls_status_enum.
 * Shared by the Call entity and the auto-progression state machine.
 */
export enum CallStatus {
  QUEUED = 'QUEUED',
  RINGING = 'RINGING',
  ANSWERED = 'ANSWERED',
  UNANSWERED = 'UNANSWERED',
  COMPLETED = 'COMPLETED',
}
