/**
 * Receiver-side jitter buffer.
 *
 * QR frames arrive out of order (redundancy means the same segment is seen
 * twice, camera frames land whenever they land) and the stream loops
 * forever, so `seq` wraps back to 0 periodically. There's no bounded
 * sequence-number space in the wire protocol to do RFC3550-style wraparound
 * comparison, so instead of trying to solve global ordering, this buffer
 * only ever reasons about a small window of "the segment we're about to
 * play, and a handful after it" — much closer to how a real jitter buffer
 * (or a radio tuner) behaves anyway.
 *
 * `numSegments` (the wrap period) isn't known up front either — it's
 * learned empirically as `max(seq) + 1`. That estimate stabilizes after the
 * first loop and makes the wraparound arithmetic below correct from then
 * on. Before it stabilizes (i.e. during the receiver's first ~1 loop of
 * tuning in), a spurious backward jump is possible; buildSchedule already
 * spaces repeats 3 segments apart, so a single mis-ordered segment right at
 * tune-in just costs one gap, not a stuck stream.
 */
import type { DecodedPacket } from './protocol';

export const DEFAULT_FRAME_MS = 20;
export const DEFAULT_TARGET_BUFFER_MS = 1000;

interface StoredSegment {
  opusPackets: Uint8Array[];
  timestampMs: number;
}

export interface PulledFrame {
  /** Raw Opus packet bytes, or null if this frame slot is a gap (caller should insert silence / PLC). */
  bytes: Uint8Array | null;
  seq: number;
}

export interface JitterBufferStats {
  streamId: number | null;
  /** How many segments (from the current play position) are contiguously available. */
  bufferedAheadMs: number;
  /** Fraction of pulled frames that were gaps, over a rolling window. */
  lossRate: number;
  segmentsBuffered: number;
}

export interface JitterBufferOptions {
  frameMs?: number;
  targetBufferMs?: number;
}

const LOSS_WINDOW = 250; // ~5s of frames at 20ms

export class JitterBuffer {
  private readonly frameMs: number;
  private readonly targetBufferMs: number;

  private streamId: number | null = null;
  private segments = new Map<number, StoredSegment>();
  private numSegmentsEstimate = 1;
  private avgPacketsPerSegment = 1;

  private nextPlaySeq: number | null = null;
  private playIntraIndex = 0;
  private firstPacketAt: number | null = null;
  private started = false;

  private lossWindow: boolean[] = [];

  constructor(opts: JitterBufferOptions = {}) {
    this.frameMs = opts.frameMs ?? DEFAULT_FRAME_MS;
    this.targetBufferMs = opts.targetBufferMs ?? DEFAULT_TARGET_BUFFER_MS;
  }

  reset(): void {
    this.streamId = null;
    this.segments.clear();
    this.numSegmentsEstimate = 1;
    this.nextPlaySeq = null;
    this.playIntraIndex = 0;
    this.firstPacketAt = null;
    this.started = false;
    this.lossWindow = [];
  }

  ingest(pkt: DecodedPacket, now: number): void {
    if (pkt.streamId !== this.streamId) {
      this.reset();
      this.streamId = pkt.streamId;
    }
    this.numSegmentsEstimate = Math.max(this.numSegmentsEstimate, pkt.seq + 1);
    this.avgPacketsPerSegment = pkt.opusPackets.length || this.avgPacketsPerSegment;

    if (this.nextPlaySeq === null) this.nextPlaySeq = pkt.seq;
    if (this.firstPacketAt === null) this.firstPacketAt = now;

    if (!this.segments.has(pkt.seq)) {
      this.segments.set(pkt.seq, { opusPackets: pkt.opusPackets, timestampMs: pkt.timestampMs });
    }
  }

  /** True once we should start pulling frames (targetBufferMs elapsed since the first packet). */
  isReady(now: number): boolean {
    if (this.started) return true;
    if (this.firstPacketAt === null) return false;
    if (now - this.firstPacketAt >= this.targetBufferMs) {
      this.started = true;
      return true;
    }
    return false;
  }

  /** Pulls the next 20ms Opus frame in playback order. Call at a steady frameMs cadence once isReady(). */
  pullFrame(): PulledFrame | null {
    if (this.nextPlaySeq === null) return null;

    const seq = this.nextPlaySeq;
    const segment = this.segments.get(seq);
    const packetsInSegment = segment ? segment.opusPackets.length : Math.round(this.avgPacketsPerSegment);
    const bytes = segment ? (segment.opusPackets[this.playIntraIndex] ?? null) : null;

    this.recordLoss(bytes === null);

    this.playIntraIndex++;
    if (this.playIntraIndex >= packetsInSegment) {
      this.playIntraIndex = 0;
      this.segments.delete(seq);
      this.nextPlaySeq = (seq + 1) % this.numSegmentsEstimate;
    }

    return { bytes, seq };
  }

  private recordLoss(isGap: boolean): void {
    this.lossWindow.push(isGap);
    if (this.lossWindow.length > LOSS_WINDOW) this.lossWindow.shift();
  }

  stats(): JitterBufferStats {
    let bufferedSegments = 0;
    if (this.nextPlaySeq !== null) {
      let seq = this.nextPlaySeq;
      while (this.segments.has(seq) && bufferedSegments < this.numSegmentsEstimate) {
        bufferedSegments++;
        seq = (seq + 1) % this.numSegmentsEstimate;
      }
    }
    const avgSegmentMs = this.avgPacketsPerSegment * this.frameMs;
    const lossRate = this.lossWindow.length > 0 ? this.lossWindow.filter(Boolean).length / this.lossWindow.length : 0;

    return {
      streamId: this.streamId,
      bufferedAheadMs: bufferedSegments * avgSegmentMs,
      lossRate,
      segmentsBuffered: this.segments.size,
    };
  }
}
