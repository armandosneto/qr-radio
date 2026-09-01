/**
 * Groups raw 20ms Opus packets into segments (one segment = one QR frame's
 * worth of payload) and builds the redundant playback schedule the emitter
 * walks through.
 *
 * Redundancy: every segment is shown twice — once as its first transmission,
 * once as a repeat — spaced `redundancyOffset` segments apart (default 3).
 * With ~400ms segments that puts roughly 1.2s between the two showings of
 * the same segment, so a blur or occlusion under ~1s can only ever take out
 * one of the two copies. The repeat is a distinct schedule entry, not a
 * back-to-back duplicate frame, which is what makes it resilient to a
 * sustained (not just instantaneous) blur.
 */
import { FIXED_OVERHEAD } from './protocol';

export interface Segment {
  seq: number;
  timestampMs: number;
  opusPackets: Uint8Array[];
}

export interface ScheduleEntry {
  seq: number;
  isRepeat: boolean;
  dueAtMs: number;
}

export interface PacketizeResult {
  segments: Segment[];
  schedule: ScheduleEntry[];
  /** Total nominal duration of the source audio, in ms — the loop period. */
  totalDurationMs: number;
}

export interface PacketizeOptions {
  /** Target segment duration in ms. Segments may end early if the QR byte budget is hit first. Default 400. */
  segmentMs?: number;
  /** Duration of each input Opus packet in ms. Default 20. */
  frameMs?: number;
  /** Max protocol payload bytes per segment (QR byte capacity minus protocol overhead). */
  maxPayloadBytes: number;
  /** How many segments apart the repeat of a segment is scheduled. Default 3. */
  redundancyOffset?: number;
}

/** Convenience: derive the max payload budget from a QR's total byte-mode capacity. */
export function maxPayloadFromQrCapacity(qrCapacityBytes: number): number {
  return Math.max(0, qrCapacityBytes - FIXED_OVERHEAD);
}

export function packetize(opusPackets: Uint8Array[], opts: PacketizeOptions): PacketizeResult {
  const segmentMs = opts.segmentMs ?? 400;
  const frameMs = opts.frameMs ?? 20;
  const redundancyOffset = opts.redundancyOffset ?? 3;
  const maxPayloadBytes = opts.maxPayloadBytes;
  const targetPacketsPerSegment = Math.max(1, Math.round(segmentMs / frameMs));

  if (maxPayloadBytes <= 0) {
    throw new Error('maxPayloadBytes must be positive — QR version/ECC too small for the protocol overhead');
  }

  const segments: Segment[] = [];
  let cursor = 0;
  let packetIndex = 0;

  while (cursor < opusPackets.length) {
    let payloadBytes = 0;
    const group: Uint8Array[] = [];

    while (
      cursor < opusPackets.length &&
      group.length < targetPacketsPerSegment &&
      payloadBytes + 2 + opusPackets[cursor].length <= maxPayloadBytes
    ) {
      payloadBytes += 2 + opusPackets[cursor].length;
      group.push(opusPackets[cursor]);
      cursor++;
    }

    if (group.length === 0) {
      // A single packet alone exceeds the budget — this is a caller
      // configuration error (QR version too small for the Opus bitrate),
      // not something to silently drop.
      throw new Error(
        `Opus packet of ${opusPackets[cursor].length} bytes exceeds the ${maxPayloadBytes}-byte payload budget`,
      );
    }

    segments.push({
      seq: segments.length,
      timestampMs: packetIndex * frameMs,
      opusPackets: group,
    });
    packetIndex += group.length;
  }

  const lastSegment = segments[segments.length - 1];
  const totalDurationMs = lastSegment
    ? lastSegment.timestampMs + lastSegment.opusPackets.length * frameMs
    : 0;

  const schedule = buildSchedule(segments, segmentMs, redundancyOffset);

  return { segments, schedule, totalDurationMs };
}

function buildSchedule(segments: Segment[], segmentMs: number, redundancyOffset: number): ScheduleEntry[] {
  const entries: ScheduleEntry[] = [];

  for (const seg of segments) {
    entries.push({ seq: seg.seq, isRepeat: false, dueAtMs: seg.timestampMs });
    entries.push({
      seq: seg.seq,
      isRepeat: true,
      dueAtMs: seg.timestampMs + redundancyOffset * segmentMs,
    });
  }

  entries.sort((a, b) => a.dueAtMs - b.dueAtMs);
  return entries;
}
