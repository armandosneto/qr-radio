/**
 * Bandwidth budget invariant for the emitter.
 *
 * The render loop (EmitterClient.tsx) walks the packetizer's schedule by
 * *real elapsed wall-clock time*, not by tick count: on every tick it
 * advances the schedule pointer past every entry whose `dueAtMs` has
 * already passed. If the render fps is too low relative to how fast
 * entries become due, the loop doesn't fall behind and "catch up later" —
 * it silently *skips* entries, jumping straight to the latest one that's
 * due. A skipped entry is never drawn at all, which is a stronger failure
 * than ordinary transmission loss: no amount of receiver-side jitter
 * buffering can recover data that was never put on screen.
 *
 * Each segment needs `redundancyFactor` total appearances (currently 2:
 * one first transmission + one repeat) to get its full redundancy. So the
 * render loop needs to display `redundancyFactor` schedule entries per
 * segment period (`segmentMs`), i.e. an entry rate of
 * `1000 * redundancyFactor / segmentMs` per second. If the configured fps
 * is below that, entries start getting skipped — audio the emitter thinks
 * it "sent" that never actually reached the screen.
 */
import { getByteCapacity, type EccLevel } from './qr-capacity';
import { maxPayloadFromQrCapacity } from './packetizer';

const FRAME_MS = 20;

export interface BudgetInput {
  bitrateBps: number;
  qrVersion: number;
  ecc: EccLevel;
  fps: number;
  /** Total appearances per segment needed for full redundancy. The current packetizer always does 2 (original + one repeat). */
  redundancyFactor: number;
}

export interface BudgetResult {
  /** Audio-ms actually deliverable per 1000ms of real time, divided by 1000 — 1.0 = exactly real-time, no margin. */
  ratio: number;
  audioMsPerSecond: number;
  packetSize: number;
  packetsPerSegment: number;
  segmentMs: number;
  /** Minimum fps needed for `ratio` to reach 1.0 at this bitrate/QR config — useful for the "which knob to loosen" message. */
  minFpsForRealtime: number;
}

export function computeBudget(input: BudgetInput): BudgetResult {
  const packetSize = Math.round((input.bitrateBps * FRAME_MS) / 1000 / 8);
  const qrCapacity = getByteCapacity(input.qrVersion, input.ecc);
  const netPayload = maxPayloadFromQrCapacity(qrCapacity);
  const packetsPerSegment = packetSize > 0 ? Math.max(0, Math.floor(netPayload / packetSize)) : 0;
  const segmentMs = packetsPerSegment * FRAME_MS;

  const uniqueSegmentsPerSecond = input.fps / input.redundancyFactor;
  const audioMsPerSecond = uniqueSegmentsPerSecond * segmentMs;
  const ratio = audioMsPerSecond / 1000;

  const minFpsForRealtime = segmentMs > 0 ? (1000 * input.redundancyFactor) / segmentMs : Infinity;

  return { ratio, audioMsPerSecond, packetSize, packetsPerSegment, segmentMs, minFpsForRealtime };
}

/** Minimum acceptable ratio before the emitter refuses to start. */
export const MIN_SAFE_BUDGET_RATIO = 1.2;
