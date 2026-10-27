import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { encodeBody, truncatedBodyFields, type BodyFields } from '@replay-parity/core';

/**
 * Collects a body as it streams. Every byte goes into a running SHA-256 and
 * a count. Chunks are kept until the count passes the cap and dropped after
 * that, so a body of any size costs at most the cap in memory. A body within
 * the cap is stored by the same rules as a body received whole, so JSON is
 * parsed, a compressed body is decoded, and the decoded size is capped as
 * well. A body over the cap is stored as the hash and size of the bytes as
 * received, with its codings noted.
 */
export class CappedBody {
  private readonly hash = createHash('sha256');
  private chunks: Buffer[] | null = [];
  private count = 0;

  constructor(private readonly maxBytes: number) {}

  /** Bytes seen so far. */
  get size(): number {
    return this.count;
  }

  /** True once the count has passed the cap and the kept chunks were dropped. */
  get overCap(): boolean {
    return this.chunks === null;
  }

  push(chunk: Buffer): void {
    this.hash.update(chunk);
    this.count += chunk.byteLength;
    if (this.chunks === null) return;
    if (this.count > this.maxBytes) {
      this.chunks = null;
      return;
    }
    this.chunks.push(chunk);
  }

  /** The fields to record. Call once, after the last chunk. */
  fields(contentType: string | undefined, contentEncoding: string | undefined): BodyFields {
    if (this.chunks === null) {
      return truncatedBodyFields(this.hash.digest('hex'), this.count, contentEncoding);
    }
    return encodeBody(Buffer.concat(this.chunks), contentType, this.maxBytes, contentEncoding);
  }
}
