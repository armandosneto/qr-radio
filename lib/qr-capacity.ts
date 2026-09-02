/**
 * Byte-mode capacity for a given QR version + error-correction level.
 *
 * Rather than hardcoding the ISO 18004 capacity table (40 versions x 4 ECC
 * levels), we ask the `qrcode` package itself: `QRCode.create` throws when
 * the payload doesn't fit a fixed version, so a binary search over payload
 * length gives the exact byte-mode capacity through the same code path that
 * will actually render the frame. Results are memoized — capacity per
 * version/ECC never changes at runtime.
 */
import QRCode from 'qrcode';

export type EccLevel = 'L' | 'M' | 'Q' | 'H';

const cache = new Map<string, number>();

function fitsAtLength(len: number, version: number, ecc: EccLevel): boolean {
  try {
    QRCode.create([{ data: new Uint8Array(len), mode: 'byte' }], {
      version,
      errorCorrectionLevel: ecc,
    });
    return true;
  } catch {
    return false;
  }
}

/** Maximum byte-mode payload (in bytes) that fits in a single QR at this version/ECC. */
export function getByteCapacity(version: number, ecc: EccLevel): number {
  const key = `${version}:${ecc}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  // Upper bound: version 40-H is well under 2000 bytes in byte mode.
  let lo = 0;
  let hi = 2953;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fitsAtLength(mid, version, ecc)) lo = mid;
    else hi = mid - 1;
  }
  cache.set(key, lo);
  return lo;
}

const alphaCache = new Map<string, number>();

function fitsAtAlphaLength(len: number, version: number, ecc: EccLevel): boolean {
  try {
    // '0' is in the alphanumeric-mode character set — same technique as
    // fitsAtLength above, just forcing mode:'alphanumeric' instead of 'byte'.
    QRCode.create([{ data: '0'.repeat(len), mode: 'alphanumeric' }], {
      version,
      errorCorrectionLevel: ecc,
    });
    return true;
  } catch {
    return false;
  }
}

/** Maximum alphanumeric-mode payload (in *characters*, not bytes) that fits at this version/ECC. */
export function getAlphanumericCapacity(version: number, ecc: EccLevel): number {
  const key = `${version}:${ecc}`;
  const cached = alphaCache.get(key);
  if (cached !== undefined) return cached;

  // Upper bound: alphanumeric packs ~2 chars per byte-mode byte at best
  // (11 bits/2 chars vs 8 bits/byte), so byte-mode's cap is a safe ceiling.
  let lo = 0;
  let hi = 2953 * 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fitsAtAlphaLength(mid, version, ecc)) lo = mid;
    else hi = mid - 1;
  }
  alphaCache.set(key, lo);
  return lo;
}
