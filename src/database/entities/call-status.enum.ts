/**
 * Postgres enum type: calls_status_enum.
 * Shared by the Call entity (PR #2) and the state machine (PR #6).
 */
export enum CallStatus {
  QUEUED = 'QUEUED',
  RINGING = 'RINGING',
  ANSWERED = 'ANSWERED',
  UNANSWERED = 'UNANSWERED',
  COMPLETED = 'COMPLETED',
}
