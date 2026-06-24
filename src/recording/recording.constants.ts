/**
 * BullMQ queue and job name constants for the recording pipeline.
 *
 * Queue name: 'recording'
 * Job name:   'upload-recording'
 *
 * Job payload shape:
 *   { callId: string }
 *
 * Producer (PR #8): RecordingDispatchService.dispatch(callId) enqueues a job
 * on this queue after a call reaches the COMPLETED state and is durably written
 * to Postgres.
 *
 * Consumer (PR #9): A @Processor('recording') worker will pick up
 * 'upload-recording' jobs, upload the call recording to S3, and write the
 * resulting S3 URL back to the call row in Postgres (recording_url column) and
 * to the Redis hash (recordingUrl field).
 */

/** BullMQ queue name for recording upload jobs. */
export const RECORDING_QUEUE = 'recording';

/** BullMQ job name for an individual recording upload task. */
export const RECORDING_JOB = 'upload-recording';
