/**
 * Client-side decode + Opus encode pipeline for the emitter.
 *
 * Decoding uses `AudioContext.decodeAudioData`, which is native in every
 * major browser and resamples to whatever sampleRate the context was built
 * with — so requesting a 48kHz context gets us resampled PCM for free,
 * without pulling in ffmpeg-wasm.
 *
 * Encoding uses the WebCodecs `AudioEncoder` with codec 'opus'. This is the
 * one hard browser requirement of this whole pipeline: WebCodecs audio
 * encoding is Chromium-only today (Chrome/Edge/Opera; not Safari, not
 * Firefox). `isOpusEncodeSupported()` lets the UI detect that up front and
 * point the user at the `/api/encode` server fallback instead of failing
 * mid-upload.
 *
 * We pin the Opus frame duration to 20ms explicitly (`opus.frameDuration`)
 * so encoder output lines up 1:1 with input chunks — WebCodecs does not
 * otherwise guarantee that an encoder won't internally re-buffer to a
 * different frame size.
 */

export const OPUS_SAMPLE_RATE = 48000;
export const OPUS_FRAME_MS = 20;
export const OPUS_SAMPLES_PER_FRAME = (OPUS_SAMPLE_RATE * OPUS_FRAME_MS) / 1000; // 960

export interface EncodeProgress {
  processedMs: number;
  totalMs: number;
}

export interface EncodeResult {
  packets: Uint8Array[];
  durationMs: number;
  frameMs: number;
  sampleRate: number;
}

export function isOpusEncodeSupported(): boolean {
  return typeof window !== 'undefined' && 'AudioEncoder' in window && 'AudioData' in window;
}

async function decodeToMonoPcm(file: File): Promise<Float32Array> {
  const arrayBuffer = await file.arrayBuffer();
  // OfflineAudioContext just to get resampling to 48kHz for free; we never render it.
  const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx({ sampleRate: OPUS_SAMPLE_RATE });
  try {
    const buffer = await ctx.decodeAudioData(arrayBuffer);
    if (buffer.numberOfChannels === 1) {
      return buffer.getChannelData(0).slice();
    }
    const mono = new Float32Array(buffer.length);
    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    for (let i = 0; i < buffer.length; i++) {
      let sum = 0;
      for (let c = 0; c < channels.length; c++) sum += channels[c][i];
      mono[i] = sum / channels.length;
    }
    return mono;
  } finally {
    void ctx.close();
  }
}

/**
 * Decodes an uploaded audio file and encodes it to a flat list of raw Opus
 * packets, one per 20ms frame, in playback order.
 */
export async function encodeFileToOpusPackets(
  file: File,
  bitrate = 24_000,
  onProgress?: (p: EncodeProgress) => void,
): Promise<EncodeResult> {
  if (!isOpusEncodeSupported()) {
    throw new Error('WebCodecs AudioEncoder(opus) is not available in this browser');
  }

  const pcm = await decodeToMonoPcm(file);
  const totalFrames = pcm.length;
  const totalMs = (totalFrames / OPUS_SAMPLE_RATE) * 1000;

  const packets: Uint8Array[] = [];
  let encodeError: Error | null = null;

  const encoder = new AudioEncoder({
    output: (chunk) => {
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      packets.push(bytes);
    },
    error: (err) => {
      encodeError = err instanceof Error ? err : new Error(String(err));
    },
  });

  encoder.configure({
    codec: 'opus',
    sampleRate: OPUS_SAMPLE_RATE,
    numberOfChannels: 1,
    bitrate,
    // Constant bitrate — the wire protocol now stores one packetSize for the
    // whole segment instead of a per-packet length prefix, which only holds
    // up if every 20ms packet really is the same byte size. See
    // packOpusPayload() in lib/protocol.ts.
    bitrateMode: 'constant',
    opus: { frameDuration: OPUS_FRAME_MS * 1000 }, // microseconds
  });

  let sampleOffset = 0;
  let frameIndex = 0;
  while (sampleOffset < totalFrames) {
    if (encodeError) throw encodeError;

    const remaining = totalFrames - sampleOffset;
    const frameSamples = Math.min(OPUS_SAMPLES_PER_FRAME, remaining);

    // Pad the final partial frame with silence — Opus needs fixed-size frames.
    const frameData = new Float32Array(OPUS_SAMPLES_PER_FRAME);
    frameData.set(pcm.subarray(sampleOffset, sampleOffset + frameSamples));

    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate: OPUS_SAMPLE_RATE,
      numberOfFrames: OPUS_SAMPLES_PER_FRAME,
      numberOfChannels: 1,
      timestamp: frameIndex * OPUS_FRAME_MS * 1000,
      data: frameData,
    });
    encoder.encode(audioData);
    audioData.close();

    sampleOffset += frameSamples;
    frameIndex++;

    if (onProgress && frameIndex % 25 === 0) {
      onProgress({ processedMs: sampleOffset / (OPUS_SAMPLE_RATE / 1000), totalMs });
    }

    // Yield to the event loop periodically so the tab stays responsive on long files.
    if (frameIndex % 200 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  await encoder.flush();
  encoder.close();
  if (encodeError) throw encodeError;

  onProgress?.({ processedMs: totalMs, totalMs });

  return { packets, durationMs: totalMs, frameMs: OPUS_FRAME_MS, sampleRate: OPUS_SAMPLE_RATE };
}
