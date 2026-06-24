import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  BucketAlreadyExists,
  BucketAlreadyOwnedByYou,
} from '@aws-sdk/client-s3';
import { Configuration } from '../config/configuration';

/**
 * RecordingStorageService encapsulates all S3 (or LocalStack) interactions for
 * the recording worker.
 *
 * Design decisions:
 *  - The S3Client is constructed eagerly in the constructor so DI wiring errors
 *    surface at module init rather than first upload.
 *  - Bucket creation on init is best-effort: if the bucket already exists (the
 *    normal production case after the first deployment) the error is swallowed.
 *    Any other error is also swallowed because the worker should not crash on
 *    startup if the bucket pre-exists or if CreateBucket returns an unexpected
 *    code - the upload itself will fail with a clear error if the bucket is
 *    genuinely missing.
 *  - URL scheme: path-style S3 URLs are used so the same code works against both
 *    LocalStack (`http://localstack:4566/<bucket>/<key>`) and real AWS
 *    (`https://s3.<region>.amazonaws.com/<bucket>/<key>`).  Virtual-host-style
 *    URLs (bucket.s3.amazonaws.com) are NOT used here because LocalStack does
 *    not support them without additional DNS configuration.
 */
@Injectable()
export class RecordingStorageService implements OnModuleInit {
  private readonly logger = new Logger(RecordingStorageService.name);
  private readonly s3: S3Client;

  /** Resolved config values cached for use in upload() and onModuleInit(). */
  private readonly endpoint: string;
  private readonly bucket: string;

  constructor(private readonly config: ConfigService<Configuration, true>) {
    const s3Cfg = this.config.get('s3', { infer: true });

    this.endpoint = s3Cfg.endpoint;
    this.bucket = s3Cfg.bucket;

    // Build the S3Client with LocalStack-compatible settings.
    // forcePathStyle: true - use http://host/bucket/key instead of bucket.host/key.
    // endpoint - point at LocalStack (or a real AWS endpoint when overridden).
    // credentials - static LocalStack test credentials; ignored by real AWS when
    //               IAM role / env-based credentials are present instead.
    this.s3 = new S3Client({
      endpoint: s3Cfg.endpoint,
      region: s3Cfg.region,
      credentials: {
        accessKeyId: s3Cfg.accessKeyId,
        secretAccessKey: s3Cfg.secretAccessKey,
      },
      forcePathStyle: s3Cfg.forcePathStyle,
    });
  }

  /**
   * Called by Nest after all providers in the module are instantiated.
   * Attempts to create the recording bucket in a best-effort fashion.
   *
   * Why best-effort?
   *   In a production environment the bucket will already exist (created by
   *   Terraform / CDK on first deploy).  CreateBucket on an existing bucket
   *   returns BucketAlreadyExists or BucketAlreadyOwnedByYou - both are safe to
   *   swallow.  Any unexpected error is logged and ignored so the worker still
   *   starts; the upload path will surface the real error if the bucket is
   *   genuinely inaccessible.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket }));
      this.logger.log(`S3 bucket '${this.bucket}' created (or already exists)`);
    } catch (err) {
      // BucketAlreadyExists and BucketAlreadyOwnedByYou are expected when the
      // bucket was created by a previous worker start or a prior deployment.
      if (err instanceof BucketAlreadyExists || err instanceof BucketAlreadyOwnedByYou) {
        this.logger.debug(`S3 bucket '${this.bucket}' already exists - skipping creation`);
      } else {
        // Log but do NOT rethrow: we want the worker to start even if S3 is
        // temporarily unreachable at boot time; the upload will fail loudly later.
        this.logger.warn(`Could not ensure S3 bucket exists: ${String(err)}`);
      }
    }
  }

  /**
   * Upload a Buffer to S3 at the given key and return the path-style object URL.
   *
   * URL scheme (path-style):
   *   `${endpoint}/${bucket}/${key}`
   *   e.g. http://localstack:4566/call-recordings/recordings/abc-123.mp3
   *
   * Path-style is used (instead of virtual-host) because LocalStack does not
   * resolve bucket subdomains without extra DNS setup, and we want the same code
   * to work against both LocalStack and real AWS (with forcePathStyle toggled off
   * via config for real AWS if desired in the future).
   *
   * Errors from PutObjectCommand propagate to the caller so BullMQ can retry the
   * job on transient S3 failures.
   *
   * @param key         S3 object key, e.g. `recordings/<callId>.mp3`
   * @param body        Raw bytes to upload
   * @param contentType MIME type, e.g. `audio/mpeg`
   * @returns           Path-style public URL of the uploaded object
   */
  async upload(key: string, body: Buffer, contentType: string): Promise<string> {
    this.logger.log(`Uploading ${body.byteLength} bytes to s3://${this.bucket}/${key}`);

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );

    // Construct path-style URL: <endpoint>/<bucket>/<key>
    // Trim any trailing slash from the endpoint to avoid double-slashes.
    const url = `${this.endpoint.replace(/\/$/, '')}/${this.bucket}/${key}`;

    this.logger.log(`Upload complete: ${url}`);
    return url;
  }
}
