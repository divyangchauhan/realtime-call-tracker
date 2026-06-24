/**
 * Redis pub/sub channel on which CallProgressionService publishes every state
 * transition event for a call.
 *
 * Published payload shape (JSON-stringified):
 *   The object produced by `callResponseFromState(state)`:
 *   {
 *     id:            string,   // call UUID
 *     from:          string,   // originating number
 *     to:            string,   // destination number
 *     status:        CallStatus, // current status after this transition
 *     metadata:      Record<string, unknown> | null,
 *     recording_url: string | null,
 *     created_at:    string,  // ISO 8601 UTC
 *     updated_at:    string,  // ISO 8601 UTC — reflects this transition
 *   }
 *
 * Subscribers (PR #7 WebSocket gateway) SUBSCRIBE to this channel and forward
 * the raw JSON payload straight to connected WebSocket clients for the call.
 */
export const CALL_EVENTS_CHANNEL = 'call:events';
