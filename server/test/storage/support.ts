import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { S3Storage } from '../../src/storage/s3';
import type { ObjectStorage, StoredObject } from '../../src/storage/types';

/** MinIO (or any S3) used by the integration tests. Tests skip when these are unset. */
export const s3Env = {
  endpoint: process.env['TEST_S3_ENDPOINT'],
  bucket: process.env['TEST_S3_BUCKET'],
  accessKeyId: process.env['TEST_S3_ACCESS_KEY_ID'],
  secretAccessKey: process.env['TEST_S3_SECRET_ACCESS_KEY'],
};
export const s3Configured = Object.values(s3Env).every(Boolean);

export function realStorage(): S3Storage {
  return new S3Storage({
    endpoint: s3Env.endpoint as string,
    region: 'us-east-1',
    bucket: s3Env.bucket as string,
    accessKeyId: s3Env.accessKeyId as string,
    secretAccessKey: s3Env.secretAccessKey as string,
    forcePathStyle: true,
  });
}

/** A PDF-looking blob of exactly `size` bytes (magic header + random filler) and its fingerprint. */
export function makePdf(size: number, seed = ''): { bytes: Buffer; fp: string } {
  const head = Buffer.from(`%PDF-1.7\n%${seed}\n`);
  const bytes = Buffer.concat([head, randomBytes(Math.max(0, size - head.length))]).subarray(
    0,
    size,
  );
  return { bytes, fp: createHash('sha256').update(bytes).digest('hex') };
}

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** In-memory storage with failure injection, for retry and failure-path tests. */
export class FakeStorage implements ObjectStorage {
  objects = new Map<string, { bytes: Buffer; lastModified: Date }>();
  failDelete = false;
  failPut = false;
  deleteCalls: string[] = [];

  async putStream(key: string, body: NodeJS.ReadableStream): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(Buffer.from(c as Buffer));
    if (this.failPut) throw new Error('injected put failure');
    this.objects.set(key, { bytes: Buffer.concat(chunks), lastModified: new Date() });
  }
  async getStream(key: string) {
    const o = this.objects.get(key);
    if (!o) return null;
    return {
      stream: Readable.toWeb(Readable.from([o.bytes])) as ReadableStream<Uint8Array>,
      contentLength: o.bytes.length,
    };
  }
  async delete(key: string): Promise<void> {
    this.deleteCalls.push(key);
    if (this.failDelete) throw new Error('injected delete failure');
    this.objects.delete(key);
  }
  async deletePrefix(prefix: string): Promise<number> {
    if (this.failDelete) throw new Error('injected delete failure');
    let n = 0;
    for (const k of [...this.objects.keys()]) {
      if (k.startsWith(prefix)) {
        this.objects.delete(k);
        n += 1;
      }
    }
    return n;
  }
  async *list(prefix: string): AsyncGenerator<StoredObject> {
    for (const [key, o] of this.objects) {
      if (key.startsWith(prefix)) yield { key, size: o.bytes.length, lastModified: o.lastModified };
    }
  }
}
