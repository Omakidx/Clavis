// Object storage port (docs/clavis-sync-design.md §6). The S3 adapter implements it; tests can use a fake.

export interface StoredObject {
  key: string;
  size: number;
  lastModified: Date;
}

export interface ObjectStorage {
  /**
   * Upload `body` as one object (multipart with 5 MiB parts when large). Rejects when `body` errors or `signal`
   * aborts; the multipart upload is aborted so no parts are left behind.
   */
  putStream(
    key: string,
    body: NodeJS.ReadableStream,
    opts: { contentType: string; signal?: AbortSignal | undefined },
  ): Promise<void>;
  /** The object as a web stream plus its exact length, or null when the key does not exist. */
  getStream(
    key: string,
  ): Promise<{ stream: ReadableStream<Uint8Array>; contentLength: number } | null>;
  /** Idempotent: deleting a missing key succeeds. */
  delete(key: string): Promise<void>;
  /** Delete every object under `prefix`. Returns how many were deleted. Throws if any deletion failed. */
  deletePrefix(prefix: string): Promise<number>;
  /** Every object under `prefix`, lazily paginated. */
  list(prefix: string): AsyncIterable<StoredObject>;
}
