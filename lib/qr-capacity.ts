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
