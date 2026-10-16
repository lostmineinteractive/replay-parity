import { randomBytes } from 'node:crypto';

/**
 * ULID generation. 26 characters of Crockford base32: 10 for the millisecond
 * timestamp and 16 for 80 bits of randomness. Within one millisecond the
 * random part increments so ids stay unique and sortable.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;
const RANDOM_MASK = (1n << 80n) - 1n;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function encodeTime(time: number): string {
  if (!Number.isInteger(time) || time < 0) {
    throw new RangeError(`ulid time must be a non negative integer, got ${String(time)}`);
  }
  let t = time;
  let out = '';
  for (let i = 0; i < TIME_LENGTH; i += 1) {
    out = ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

export function decodeTime(id: string): number {
  if (!isUlid(id)) throw new RangeError(`not a ulid: ${id}`);
  let t = 0;
  for (let i = 0; i < TIME_LENGTH; i += 1) {
    t = t * 32 + ALPHABET.indexOf(id[i] as string);
  }
  return t;
}

function encodeRandom(value: bigint): string {
  let v = value & RANDOM_MASK;
  let out = '';
  for (let i = 0; i < RANDOM_LENGTH; i += 1) {
    out = ALPHABET[Number(v % 32n)] + out;
    v /= 32n;
  }
  return out;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

export interface UlidFactoryOptions {
  now?: () => number;
  random?: (byteCount: number) => Uint8Array;
}

export function createUlidFactory(options: UlidFactoryOptions = {}): () => string {
  const now = options.now ?? Date.now;
  const random = options.random ?? ((n: number) => randomBytes(n));
  let lastTime = -1;
  let lastRandom = 0n;
  return () => {
    const time = now();
    if (time === lastTime) {
      lastRandom = (lastRandom + 1n) & RANDOM_MASK;
    } else {
      lastTime = time;
      lastRandom = bytesToBigInt(random(10));
    }
    return encodeTime(time) + encodeRandom(lastRandom);
  };
}

export const ulid: () => string = createUlidFactory();

export function isUlid(value: string): boolean {
  return ULID_PATTERN.test(value);
}
