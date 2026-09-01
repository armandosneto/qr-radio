/**
 * QR decode worker — runs off the main thread so decoding never competes
 * with the camera capture loop or audio pipeline for a frame budget.
 *
 * Two decode paths, tried in order:
 *
 * 1. Native `BarcodeDetector` (Chrome/Edge/Android Chrome; NOT desktop
 *    Linux Chrome in practice — the Shape Detection API backend isn't
 *    shipped there, only feature-detected here, not assumed). It's
 *    hardware-accelerated where present, but its `rawValue` is always a JS
 *    string. Our QR payload is raw binary with no ECI segment, which ZXing
 *    (the engine behind Chrome's implementation) decodes as byte-mode ->
 *    ISO-8859-1: every byte maps 1:1 to a code point 0-255. So
 *    `charCodeAt()` recovers the exact original byte losslessly — *as long
 *    as* every code point stays under 256. If one doesn't, the assumption
 *    broke and the frame is dropped rather than trusted.
 *
 * 2. `jsQR` (pure JS, no native dependency, works in every browser that has
 *    Workers + OffscreenCanvas). Its `binaryData` is the actual decoded
 *    byte-mode payload — no encoding-recovery trick needed, just correct by
 *    construction. This is the fallback the original plan called
 *    zxing-wasm for; jsQR was chosen instead specifically because it
 *    exposes raw bytes directly, so there's no string round-trip to get
 *    wrong.
 *
 * CRC validation happens here too, so a garbled decode never crosses the
 * worker boundary — the main thread only ever sees frames it can trust.
 */
import jsQR from 'jsqr';
import { decodePacket } from './protocol';

// Kept loose deliberately: the project's tsconfig only pulls in the "dom"
// lib (not "webworker", which conflicts with "dom" on the `self` global).
// ImageBitmap/OffscreenCanvas are already declared by "dom"; postMessage's
// worker-flavored (message, transferList) overload is not, hence `any`.
const ctx = self as unknown as {
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
  onmessage: ((event: MessageEvent) => void) | null;
  BarcodeDetector?: {
    new (options: { formats: string[] }): { detect(image: ImageBitmapSource): Promise<{ rawValue: string }[]> };
    getSupportedFormats(): Promise<string[]>;
  };
};

let barcodeDetector: InstanceType<NonNullable<typeof ctx.BarcodeDetector>> | null = null;
let barcodeDetectorChecked = false;

async function getBarcodeDetector() {
  if (barcodeDetectorChecked) return barcodeDetector;
  barcodeDetectorChecked = true;
  const Ctor = ctx.BarcodeDetector;
  if (!Ctor) return null;
  try {
    const formats = await Ctor.getSupportedFormats();
    if (!formats.includes('qr_code')) return null;
    barcodeDetector = new Ctor({ formats: ['qr_code'] });
  } catch {
    barcodeDetector = null;
  }
  return barcodeDetector;
}

function latin1StringToBytes(s: string): Uint8Array | null {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code > 0xff) return null; // decoder didn't use ISO-8859-1 — can't trust the recovery
    out[i] = code;
  }
  return out;
}

let offscreenCanvas: OffscreenCanvas | null = null;
let offscreenCtx: OffscreenCanvasRenderingContext2D | null = null;

function bitmapToImageData(bitmap: ImageBitmap): ImageData {
  if (!offscreenCanvas || offscreenCanvas.width !== bitmap.width || offscreenCanvas.height !== bitmap.height) {
    offscreenCanvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (!offscreenCtx) throw new Error('OffscreenCanvas 2D context unavailable');
  offscreenCtx.drawImage(bitmap, 0, 0);
  return offscreenCtx.getImageData(0, 0, bitmap.width, bitmap.height);
}

async function decodeFrame(bitmap: ImageBitmap): Promise<Uint8Array | null> {
  const detector = await getBarcodeDetector();
  if (detector) {
    try {
      const results = await detector.detect(bitmap);
      if (results.length > 0) {
        const bytes = latin1StringToBytes(results[0].rawValue);
        if (bytes) return bytes;
      }
    } catch {
      // Detector errored on this frame — fall through to jsQR below.
    }
  }

  const imageData = bitmapToImageData(bitmap);
  const result = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
  return result ? new Uint8Array(result.binaryData) : null;
}

interface FrameMessage {
  type: 'frame';
  id: number;
  bitmap: ImageBitmap;
  capturedAt: number;
}

ctx.onmessage = (event: MessageEvent<FrameMessage>) => {
  const { id, bitmap, capturedAt } = event.data;
  const startedAt = performance.now();

  decodeFrame(bitmap)
    .catch(() => null)
    .then((bytes) => {
      bitmap.close();
      const decodeMs = performance.now() - startedAt;

      if (!bytes) {
        ctx.postMessage({ type: 'result', id, capturedAt, decodeMs, ok: false, reason: 'no-qr' });
        return;
      }

      const packet = decodePacket(bytes);
      if (!packet) {
        ctx.postMessage({ type: 'result', id, capturedAt, decodeMs, ok: false, reason: 'crc-fail' });
        return;
      }

      const buffer = bytes.buffer as ArrayBuffer;
      const offsets = packet.opusPackets.map((p) => [p.byteOffset, p.length] as [number, number]);

      ctx.postMessage(
        {
          type: 'result',
          id,
          capturedAt,
          decodeMs,
          ok: true,
          version: packet.version,
          streamId: packet.streamId,
          seq: packet.seq,
          timestampMs: packet.timestampMs,
          isRepeat: packet.isRepeat,
          buffer,
          offsets,
        },
        [buffer],
      );
    });
};
