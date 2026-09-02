/**
 * QR Radio wire protocol.
 *
 * Every QR frame carries one self-contained packet — nothing depends on a
 * previous frame. A receiver that starts decoding mid-stream must be able to
 * parse, validate, and play any single packet in isolation.
 *
 * Layout (all multi-byte integers big-endian):
 *
 *   magic          2B   "QR" (0x51 0x52) — cheap sanity check before CRC
 *   version        1B   protocol version
 *   streamId       2B   changes whenever the emitter switches track
 *   seq            4B   segment index, monotonic within a stream
 *   timestampMs    4B   segment's position on the emitter's timeline
 *   flags          1B   bit0: 1 = redundant repeat, 0 = first transmission
 *   packetSize     2B   byte length of each Opus packet in this segment (CBR)
 *   packetCount    1B   how many Opus packets follow
 *   payload        ...  packetSize * packetCount bytes, back to back
 *   crc32          4B   CRC-32/ISO-HDLC over every byte before this field
 *
 * Fixed overhead: 17 bytes header + 4 bytes trailer = 21 bytes per frame.
 *
 * v1 of this protocol length-prefixed each Opus packet individually (2 bytes
 * per packet) to allow variable-size packets. v2 (this one) instead assumes
 * constant-bitrate Opus — true as long as the encoder is configured with
 * bitrateMode:'constant' (see lib/opus-client-encoder.ts) — and stores one
 * shared packetSize for the whole segment instead. For a typical 15-16
 * packet segment that trades 1 extra fixed header byte for 2*N removed
 * per-packet prefix bytes, a clear net win. packOpusPayload() enforces the
 * uniform-size assumption at encode time rather than trusting it silently.
 */

export const MAGIC = new Uint8Array([0x51, 0x52]); // "QR"
export const PROTOCOL_VERSION = 2;

export const HEADER_SIZE = 17; // magic..packetCount
export const TRAILER_SIZE = 4; // crc32
export const FIXED_OVERHEAD = HEADER_SIZE + TRAILER_SIZE;

/** Bit 0 of the flags byte. Set on the redundant (2nd, 3rd, ...) transmission of a segment. */
export const FLAG_REPEAT = 0b0000_0001;

export interface PacketHeader {
  version: number;
  streamId: number;
  seq: number;
  timestampMs: number;
  isRepeat: boolean;
}

export interface DecodedPacket extends PacketHeader {
  /** Individual Opus packets, in order, exactly as produced by the encoder. */
  opusPackets: Uint8Array[];
}

export class ProtocolError extends Error {}

// ---------------------------------------------------------------------------
// CRC-32/ISO-HDLC (the "zlib" CRC-32) — reflected, poly 0xEDB88320, init/xorout 0xFFFFFFFF.
// ---------------------------------------------------------------------------

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

export function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/**
 * Packs Opus packets for one segment into a single contiguous blob. Requires
 * every packet to be exactly the same size (constant-bitrate Opus) — throws
 * immediately if not, rather than silently mis-framing the payload.
 */
export function packOpusPayload(opusPackets: Uint8Array[]): { payload: Uint8Array; packetSize: number } {
  if (opusPackets.length === 0) return { payload: new Uint8Array(0), packetSize: 0 };
  if (opusPackets.length > 0xff) {
    throw new ProtocolError(`Too many packets in one segment: ${opusPackets.length} (max 255)`);
  }
  const packetSize = opusPackets[0].length;
  if (packetSize > 0xffff) {
    throw new ProtocolError(`Opus packet too large: ${packetSize} bytes`);
  }
  const payload = new Uint8Array(packetSize * opusPackets.length);
  let offset = 0;
  for (const p of opusPackets) {
    if (p.length !== packetSize) {
      throw new ProtocolError(
        `Non-uniform Opus packet size in segment: expected ${packetSize}, got ${p.length}. ` +
          `CBR mode must be enabled on the encoder (bitrateMode:'constant').`,
      );
    }
    payload.set(p, offset);
    offset += packetSize;
  }
  return { payload, packetSize };
}

export function unpackOpusPayload(payload: Uint8Array, packetSize: number, packetCount: number): Uint8Array[] {
  if (packetSize * packetCount !== payload.length) {
    throw new ProtocolError(
      `Payload length ${payload.length} doesn't match packetSize*packetCount (${packetSize}*${packetCount})`,
    );
  }
  const packets: Uint8Array[] = [];
  for (let i = 0; i < packetCount; i++) {
    packets.push(payload.subarray(i * packetSize, (i + 1) * packetSize));
  }
  return packets;
}

/**
 * Builds one complete, CRC-sealed wire packet for a single QR frame.
 */
export function encodePacket(header: PacketHeader, opusPackets: Uint8Array[]): Uint8Array {
  const { payload, packetSize } = packOpusPayload(opusPackets);

  const body = new Uint8Array(HEADER_SIZE + payload.length);
  const view = new DataView(body.buffer);

  body.set(MAGIC, 0);
  view.setUint8(2, header.version);
  view.setUint16(3, header.streamId, false);
  view.setUint32(5, header.seq >>> 0, false);
  view.setUint32(9, header.timestampMs >>> 0, false);
  view.setUint8(13, header.isRepeat ? FLAG_REPEAT : 0);
  view.setUint16(14, packetSize, false);
  view.setUint8(16, opusPackets.length);
  body.set(payload, HEADER_SIZE);

  const checksum = crc32(body);
  const out = new Uint8Array(body.length + TRAILER_SIZE);
  out.set(body, 0);
  new DataView(out.buffer).setUint32(body.length, checksum, false);
  return out;
}

/**
 * Parses and validates a single wire packet. Returns null (never throws) for
 * malformed or corrupt input — the receiver is expected to just drop the
 * frame and wait for the next one; a QR misread should never crash the
 * decode loop.
 */
export function decodePacket(bytes: Uint8Array): DecodedPacket | null {
  if (bytes.length < FIXED_OVERHEAD) return null;
  if (bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1]) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(2);
  const streamId = view.getUint16(3, false);
  const seq = view.getUint32(5, false);
  const timestampMs = view.getUint32(9, false);
  const flags = view.getUint8(13);
  const packetSize = view.getUint16(14, false);
  const packetCount = view.getUint8(16);
  const payloadLen = packetSize * packetCount;

  const expectedLen = HEADER_SIZE + payloadLen + TRAILER_SIZE;
  if (bytes.length !== expectedLen) return null;

  const body = bytes.subarray(0, HEADER_SIZE + payloadLen);
  const claimedCrc = view.getUint32(HEADER_SIZE + payloadLen, false);
  if (crc32(body) !== claimedCrc) return null;

  const payload = bytes.subarray(HEADER_SIZE, HEADER_SIZE + payloadLen);
  let opusPackets: Uint8Array[];
  try {
    opusPackets = unpackOpusPayload(payload, packetSize, packetCount);
  } catch {
    return null;
  }

  return {
    version,
    streamId,
    seq,
    timestampMs,
    isRepeat: (flags & FLAG_REPEAT) !== 0,
    opusPackets,
  };
}
