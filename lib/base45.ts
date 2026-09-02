/**
 * Base45 (RFC 9285) — encodes bytes into a 45-character alphabet that is a
 * strict subset of QR "alphanumeric mode"'s own character set. Every
 * character in that set is ASCII (code point < 128), so it decodes
 * identically under ISO-8859-1 and UTF-8 — there's no encoding ambiguity
 * left for a string-returning API (BarcodeDetector.rawValue) to get wrong.
 *
 * Pairs of characters cost 11 bits in QR alphanumeric mode (vs 8 bits/byte
 * in byte mode), and Base45 encodes 2 input bytes as 3 characters — so the
 * net QR-capacity cost is 3*11/2 = 16.5 bits per 2 original bytes, only
 * ~3% more than byte mode's 16 bits for the same 2 bytes.
 */

export const BASE45_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

const CHAR_TO_VALUE = new Map<string, number>();
for (let i = 0; i < BASE45_ALPHABET.length; i++) CHAR_TO_VALUE.set(BASE45_ALPHABET[i], i);

export function base45Encode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 1 < bytes.length; i += 2) {
    let n = bytes[i] * 256 + bytes[i + 1];
    const c = n % 45;
    n = Math.floor(n / 45);
    const d = n % 45;
    n = Math.floor(n / 45);
    const e = n;
    out += BASE45_ALPHABET[c] + BASE45_ALPHABET[d] + BASE45_ALPHABET[e];
  }
  if (i < bytes.length) {
    let n = bytes[i];
    const c = n % 45;
    n = Math.floor(n / 45);
    const d = n;
    out += BASE45_ALPHABET[c] + BASE45_ALPHABET[d];
  }
  return out;
}

export class Base45Error extends Error {}

export function base45Decode(s: string): Uint8Array {
  const out: number[] = [];
  let i = 0;
  for (; i + 2 < s.length; i += 3) {
    const c = CHAR_TO_VALUE.get(s[i]);
    const d = CHAR_TO_VALUE.get(s[i + 1]);
    const e = CHAR_TO_VALUE.get(s[i + 2]);
    if (c === undefined || d === undefined || e === undefined) {
      throw new Base45Error(`Invalid Base45 character at offset ${i}`);
    }
    const n = c + d * 45 + e * 45 * 45;
    if (n > 0xffff) throw new Base45Error(`Base45 group out of range at offset ${i}`);
    out.push(n >> 8, n & 0xff);
  }
  const remaining = s.length - i;
  if (remaining === 2) {
    const c = CHAR_TO_VALUE.get(s[i]);
    const d = CHAR_TO_VALUE.get(s[i + 1]);
    if (c === undefined || d === undefined) {
      throw new Base45Error(`Invalid Base45 character at offset ${i}`);
    }
    const n = c + d * 45;
    if (n > 0xff) throw new Base45Error(`Base45 trailing group out of range at offset ${i}`);
    out.push(n);
  } else if (remaining !== 0) {
    throw new Base45Error(`Invalid Base45 length: trailing group of ${remaining} character(s)`);
  }
  return new Uint8Array(out);
}

/** Character count Base45 produces for N input bytes, without doing the encode. */
export function base45EncodedLength(byteLength: number): number {
  const pairs = Math.floor(byteLength / 2);
  const remainder = byteLength % 2;
  return pairs * 3 + (remainder === 1 ? 2 : 0);
}

/** Max input byte length that fits in a given Base45 character budget. */
export function base45MaxBytesForChars(maxChars: number): number {
  let lo = 0;
  let hi = maxChars; // encoding never expands by more than 1.5x, so this is a safe upper bound
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (base45EncodedLength(mid) <= maxChars) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
