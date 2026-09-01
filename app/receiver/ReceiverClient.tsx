'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { JitterBuffer, DEFAULT_TARGET_BUFFER_MS } from '@/lib/jitter-buffer';
import type { DecodedPacket } from '@/lib/protocol';

const SAMPLE_RATE = 48000;
const FRAME_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_MS) / 1000; // 960
const PUMP_INTERVAL_MS = 20;

type Status = 'idle' | 'starting' | 'listening' | 'error';

interface WorkerResultOk {
  type: 'result';
  id: number;
  ok: true;
  capturedAt: number;
  decodeMs: number;
  version: number;
  streamId: number;
  seq: number;
  timestampMs: number;
  isRepeat: boolean;
  buffer: ArrayBuffer;
  offsets: [number, number][];
}
interface WorkerResultFail {
  type: 'result';
  id: number;
  ok: false;
  capturedAt: number;
  decodeMs: number;
  reason: 'no-qr' | 'crc-fail';
}
type WorkerResult = WorkerResultOk | WorkerResultFail;

interface Hud {
  streamId: number | null;
  seq: number | null;
  decodeFps: number;
  qrMissRate: number;
  bufferedMs: number;
  jitterAheadMs: number;
  lossRate: number;
  latencyMs: number;
}

const INITIAL_HUD: Hud = {
  streamId: null,
  seq: null,
  decodeFps: 0,
  qrMissRate: 0,
  bufferedMs: 0,
  jitterAheadMs: 0,
  lossRate: 0,
  latencyMs: 0,
};

export default function ReceiverClient() {
  const [status, setStatus] = useState<Status>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hud, setHud] = useState<Hud>(INITIAL_HUD);

  const videoRef = useRef<HTMLVideoElement>(null);

  const jitterBufferRef = useRef<JitterBuffer | null>(null);
  if (jitterBufferRef.current === null) {
    jitterBufferRef.current = new JitterBuffer({ frameMs: FRAME_MS, targetBufferMs: DEFAULT_TARGET_BUFFER_MS });
  }

  const workerRef = useRef<Worker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const decoderRef = useRef<{ current: AudioDecoder | null }>({ current: null });
  const pumpIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rvfcHandleRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  const frameIdRef = useRef(0);
  const chunkTimestampUsRef = useRef(0);
  const ringBufferedMsRef = useRef(0);

  const decodeEventsRef = useRef<{ t: number; ok: boolean }[]>([]);

  const stopEverything = useCallback(() => {
    if (pumpIntervalRef.current !== null) {
      clearInterval(pumpIntervalRef.current);
      pumpIntervalRef.current = null;
    }
    if (rvfcHandleRef.current !== null && videoRef.current) {
      videoRef.current.cancelVideoFrameCallback?.(rvfcHandleRef.current);
      rvfcHandleRef.current = null;
    }
    workerRef.current?.terminate();
    workerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    decoderRef.current.current?.close();
    decoderRef.current.current = null;
    workletNodeRef.current?.disconnect();
    workletNodeRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
    jitterBufferRef.current?.reset();
  }, []);

  useEffect(() => stopEverything, [stopEverything]);

  // `error` below needs to call "the current version of this function" to
  // rebuild a fresh decoder — a ref indirection (assigned in an effect, not
  // during render) instead of naming the useCallback binding directly,
  // since WebCodecs closes a decoder permanently on error and one bad frame
  // must not take down playback for the rest of the session.
  const createAudioDecoderRef = useRef<() => AudioDecoder>(() => {
    throw new Error('decoder factory not ready yet');
  });
  const createAudioDecoder = useCallback(() => {
    const decoder = new AudioDecoder({
      output: (audioData) => {
        const samples = new Float32Array(audioData.numberOfFrames);
        audioData.copyTo(samples, { planeIndex: 0, format: 'f32-planar' });
        audioData.close();
        workletNodeRef.current?.port.postMessage({ type: 'pcm', samples }, [samples.buffer]);
      },
      error: () => {
        decoderRef.current.current = createAudioDecoderRef.current();
      },
    });
    decoder.configure({ codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1 });
    return decoder;
  }, []);
  useEffect(() => {
    createAudioDecoderRef.current = createAudioDecoder;
  }, [createAudioDecoder]);

  const postSilenceFrame = useCallback(() => {
    workletNodeRef.current?.port.postMessage({ type: 'pcm', samples: new Float32Array(SAMPLES_PER_FRAME) });
  }, []);

  const pump = useCallback(() => {
    const jitterBuffer = jitterBufferRef.current;
    if (!jitterBuffer) return;
    const now = performance.now();
    if (!jitterBuffer.isReady(now)) return;

    const frame = jitterBuffer.pullFrame();
    if (!frame || !frame.bytes) {
      postSilenceFrame();
    } else {
      const decoder = decoderRef.current.current;
      if (decoder && decoder.state === 'configured') {
        chunkTimestampUsRef.current += FRAME_MS * 1000;
        try {
          decoder.decode(
            new EncodedAudioChunk({
              type: 'key',
              timestamp: chunkTimestampUsRef.current,
              data: frame.bytes as unknown as BufferSource,
            }),
          );
        } catch {
          postSilenceFrame();
        }
      } else {
        postSilenceFrame();
      }
    }

    const stats = jitterBuffer.stats();
    setHud((prev) => ({
      ...prev,
      streamId: stats.streamId,
      seq: frame ? frame.seq : prev.seq,
      jitterAheadMs: stats.bufferedAheadMs,
      lossRate: stats.lossRate,
      bufferedMs: ringBufferedMsRef.current,
      latencyMs: DEFAULT_TARGET_BUFFER_MS + ringBufferedMsRef.current,
    }));
  }, [postSilenceFrame]);

  const handleWorkerMessage = useCallback((event: MessageEvent<WorkerResult>) => {
    const msg = event.data;
    inFlightRef.current = false;
    const now = performance.now();

    decodeEventsRef.current.push({ t: now, ok: msg.ok });
    while (decodeEventsRef.current.length > 0 && now - decodeEventsRef.current[0].t > 1000) {
      decodeEventsRef.current.shift();
    }
    const window_ = decodeEventsRef.current;
    const okCount = window_.filter((e) => e.ok).length;
    setHud((prev) => ({
      ...prev,
      decodeFps: okCount,
      qrMissRate: window_.length > 0 ? 1 - okCount / window_.length : 0,
    }));

    if (!msg.ok) return;

    const buffer = msg.buffer;
    const opusPackets = msg.offsets.map(([byteOffset, length]) => new Uint8Array(buffer, byteOffset, length));
    const packet: DecodedPacket = {
      version: msg.version,
      streamId: msg.streamId,
      seq: msg.seq,
      timestampMs: msg.timestampMs,
      isRepeat: msg.isRepeat,
      opusPackets,
    };
    jitterBufferRef.current?.ingest(packet, now);
  }, []);

  // Same self-re-arming pattern as createAudioDecoder above: rVFC needs to
  // re-register itself for the next frame every time it fires.
  const onVideoFrameRef = useRef<() => void>(() => {});
  const onVideoFrame = useCallback(() => {
    const video = videoRef.current;
    const worker = workerRef.current;
    if (video && !video.paused) {
      rvfcHandleRef.current = video.requestVideoFrameCallback(() => onVideoFrameRef.current());
    }
    if (!video || !worker || inFlightRef.current) return;

    inFlightRef.current = true;
    createImageBitmap(video)
      .then((bitmap) => {
        const id = frameIdRef.current++;
        worker.postMessage({ type: 'frame', id, bitmap, capturedAt: performance.now() }, [bitmap]);
      })
      .catch(() => {
        inFlightRef.current = false;
      });
  }, []);
  useEffect(() => {
    onVideoFrameRef.current = onVideoFrame;
  }, [onVideoFrame]);

  const start = useCallback(async () => {
    setStatus('starting');
    setErrorMessage(null);
    setHud(INITIAL_HUD);

    try {
      const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const audioContext = new AudioCtx({ sampleRate: SAMPLE_RATE });
      if (audioContext.state === 'suspended') {
        // Some mobile browsers still start an AudioContext suspended even
        // inside a user-gesture handler — silent failure with no error
        // otherwise, since audio just never starts flowing.
        await audioContext.resume();
      }
      await audioContext.audioWorklet.addModule('/ring-buffer-processor.js');
      const workletNode = new AudioWorkletNode(audioContext, 'ring-buffer-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      workletNode.port.onmessage = (event: MessageEvent<{ type: string; bufferedMs: number }>) => {
        if (event.data.type === 'stats') ringBufferedMsRef.current = event.data.bufferedMs;
      };
      workletNode.connect(audioContext.destination);
      audioContextRef.current = audioContext;
      workletNodeRef.current = workletNode;

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
      }
      streamRef.current = stream;
      const [track] = stream.getVideoTracks();
      try {
        await track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] });
      } catch {
        // Continuous autofocus isn't supported everywhere — not fatal.
      }

      const video = videoRef.current;
      if (!video) throw new Error('elemento de vídeo indisponível');
      video.srcObject = stream;
      await video.play();

      const worker = new Worker(new URL('../../lib/qr-decoder-worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = handleWorkerMessage;
      workerRef.current = worker;

      decoderRef.current.current = createAudioDecoder();

      rvfcHandleRef.current = video.requestVideoFrameCallback(onVideoFrame);
      pumpIntervalRef.current = setInterval(pump, PUMP_INTERVAL_MS);

      setStatus('listening');
    } catch (err) {
      stopEverything();
      setStatus('error');
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }, [createAudioDecoder, handleWorkerMessage, onVideoFrame, pump, stopEverything]);

  const stop = useCallback(() => {
    stopEverything();
    setStatus('idle');
  }, [stopEverything]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">QR Radio — Receptor</h1>

      <video ref={videoRef} className="mx-auto w-full max-w-md rounded border border-gray-300" muted playsInline />

      <div className="flex items-center gap-4">
        {status !== 'listening' ? (
          <button
            onClick={() => void start()}
            disabled={status === 'starting'}
            className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-40"
          >
            {status === 'starting' ? 'Conectando…' : 'Ouvir'}
          </button>
        ) : (
          <button onClick={stop} className="rounded bg-red-600 px-4 py-2 text-white">
            Parar
          </button>
        )}
        {status === 'error' && errorMessage && <span className="text-sm text-red-600">{errorMessage}</span>}
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
        <HudStat label="stream_id" value={hud.streamId ?? '—'} />
        <HudStat label="seq atual" value={hud.seq ?? '—'} />
        <HudStat label="fps decodificação" value={hud.decodeFps.toFixed(0)} />
        <HudStat label="taxa de perda QR" value={`${(hud.qrMissRate * 100).toFixed(0)}%`} />
        <HudStat label="taxa de perda áudio" value={`${(hud.lossRate * 100).toFixed(0)}%`} />
        <HudStat label="buffer (jitter)" value={`${hud.jitterAheadMs.toFixed(0)} ms`} />
        <HudStat label="buffer (áudio)" value={`${hud.bufferedMs.toFixed(0)} ms`} />
        <HudStat label="latência estimada" value={`${hud.latencyMs.toFixed(0)} ms`} />
      </dl>
    </div>
  );
}

function HudStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex justify-between gap-2 rounded bg-gray-100 px-2 py-1">
      <dt className="text-gray-600">{label}</dt>
      <dd className="font-mono font-semibold text-gray-900">{value}</dd>
    </div>
  );
}
