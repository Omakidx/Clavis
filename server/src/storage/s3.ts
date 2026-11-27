import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { Config } from '../config';
import type { ObjectStorage, StoredObject } from './types';

export const PART_SIZE = 5 * 1024 * 1024;
/** Bound for every short S3 call (delete, list page, get headers). Streaming bodies use the socket idle timeout. */
const CALL_TIMEOUT_MS = 15_000;
/** A body stalled this long (no bytes on the socket) is dropped. It is an idle timeout, never a total one. */
const SOCKET_IDLE_MS = 30_000;

type S3Config = NonNullable<Config['s3']>;

const isNotFound = (err: unknown): boolean =>
  err instanceof S3ServiceException &&
  (err.name === 'NoSuchKey' || err.name === 'NotFound' || err.$metadata.httpStatusCode === 404);

export interface S3Options {
  /** Total bound for delete/list and for waiting on a GET's response headers (default 15 s; a test seam). */
  callTimeoutMs?: number;
  /** Called with the error class name when a download body fails mid-stream. */
  onStreamError?: (name: string) => void;
}

export class S3Storage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly callTimeoutMs: number;
  private readonly onStreamError: ((name: string) => void) | undefined;

  constructor(cfg: S3Config, opts: S3Options = {}) {
    this.bucket = cfg.bucket;
    this.callTimeoutMs = opts.callTimeoutMs ?? CALL_TIMEOUT_MS;
    this.onStreamError = opts.onStreamError;
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      // S3-compatible providers (R2, Tigris, MinIO) do not all accept the newer default checksum trailers.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 3,
      requestHandler: { connectionTimeout: 5_000, requestTimeout: SOCKET_IDLE_MS },
    });
  }

  async putStream(
    key: string,
    body: NodeJS.ReadableStream,
    opts: { contentType: string; signal?: AbortSignal | undefined },
  ): Promise<void> {
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: key, Body: body as never, ContentType: opts.contentType },
      partSize: PART_SIZE,
      queueSize: 2,
      leavePartsOnError: false,
    });
    const onAbort = () => void upload.abort().catch(() => undefined);
    if (opts.signal?.aborted) onAbort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await upload.done();
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  async getStream(key: string) {
    // Only the wait for response headers is bounded by the call timeout. The signal must not outlive send():
    // the SDK keeps its listener until the body is read, so a live timer would cut a slow download mid-body.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.callTimeoutMs);
    let res;
    try {
      res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
        abortSignal: abort.signal,
      });
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (!res.Body || res.ContentLength === undefined) return null;
    const reader = res.Body.transformToWebStream().getReader();
    const onError = this.onStreamError;
    // A mid-body failure must not reach the HTTP layer as a plain error: it would write the message into a response
    // that is already streaming and log it. A premature-close error just tears the connection down.
    const stream = new ReadableStream<Uint8Array>({
      async pull(ctl) {
        try {
          const { done, value } = await reader.read();
          if (done) ctl.close();
          else ctl.enqueue(value);
        } catch (err) {
          onError?.((err as Error).name);
          ctl.error(
            Object.assign(new Error('download interrupted'), {
              code: 'ERR_STREAM_PREMATURE_CLOSE',
            }),
          );
        }
      },
      cancel: (reason) => reader.cancel(reason).catch(() => undefined),
    });
    return { stream, contentLength: res.ContentLength };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), {
      abortSignal: AbortSignal.timeout(this.callTimeoutMs),
    });
  }

  async *list(prefix: string): AsyncGenerator<StoredObject> {
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ...(token ? { ContinuationToken: token } : {}),
        }),
        { abortSignal: AbortSignal.timeout(this.callTimeoutMs) },
      );
      for (const o of res.Contents ?? []) {
        if (o.Key === undefined) continue;
        yield { key: o.Key, size: o.Size ?? 0, lastModified: o.LastModified ?? new Date(0) };
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
  }

  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0;
    let batch: string[] = [];
    const flush = async () => {
      if (batch.length === 0) return;
      const res = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
        { abortSignal: AbortSignal.timeout(this.callTimeoutMs) },
      );
      if (res.Errors && res.Errors.length > 0) {
        throw new Error(`failed to delete ${res.Errors.length} objects`);
      }
      deleted += batch.length;
      batch = [];
    };
    for await (const o of this.list(prefix)) {
      batch.push(o.key);
      if (batch.length >= 1000) await flush();
    }
    await flush();
    return deleted;
  }
}

/** The configured storage, or undefined when S3 is not configured (file routes then answer 503). */
export function createStorage(cfg: Config['s3'], opts: S3Options = {}): ObjectStorage | undefined {
  return cfg ? new S3Storage(cfg, opts) : undefined;
}
