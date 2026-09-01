'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { OpusDecoder } from 'opus-decoder';
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

type PermissionCheck = PermissionState | 'unsupported' | 'checking';
type Platform = 'ios' | 'android' | 'desktop/outro';

interface StaticDiagnostics {
  secureContext: boolean;
  hasGetUserMedia: boolean;
  platform: Platform;
}

interface Diagnostics extends StaticDiagnostics {
  cameraPermission: PermissionCheck;
  audioContextState: AudioContextState | 'não iniciado';
}

function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Mac') && navigator.maxTouchPoints > 1);
  if (isIOS) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop/outro';
}

// Read once — these don't change over the component's lifetime, so this is
// a plain render-time computation (like isOpusEncodeSupported on the
// emitter), not an effect. Only the truly async/subscription-based bits
// below (camera permission, AudioContext state) need useEffect/useState.
function readStaticDiagnostics(): StaticDiagnostics {
  return {
    secureContext: window.isSecureContext,
    hasGetUserMedia: !!navigator.mediaDevices?.getUserMedia,
    platform: detectPlatform(),
  };
}

export default function ReceiverClient() {
  const [status, setStatus] = useState<Status>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hud, setHud] = useState<Hud>(INITIAL_HUD);
  const staticDiagnostics = useMemo(() => readStaticDiagnostics(), []);
  const [cameraPermission, setCameraPermission] = useState<PermissionCheck>('checking');
  const [audioContextState, setAudioContextState] = useState<AudioContextState | 'não iniciado'>('não iniciado');
  const diagnostics: Diagnostics = { ...staticDiagnostics, cameraPermission, audioContextState };

  const videoRef = useRef<HTMLVideoElement>(null);

  const jitterBufferRef = useRef<JitterBuffer | null>(null);
  if (jitterBufferRef.current === null) {
    jitterBufferRef.current = new JitterBuffer({ frameMs: FRAME_MS, targetBufferMs: DEFAULT_TARGET_BUFFER_MS });
  }

  const workerRef = useRef<Worker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const decoderRef = useRef<OpusDecoder | null>(null);
  const pumpIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rvfcHandleRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  const frameIdRef = useRef(0);
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
    decoderRef.current?.free();
    decoderRef.current = null;
    workletNodeRef.current?.disconnect();
    workletNodeRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
    jitterBufferRef.current?.reset();
    setAudioContextState('não iniciado');
  }, []);

  useEffect(() => stopEverything, [stopEverything]);

  // Runs once on mount so the page can tell you *why* "Ouvir" won't work
  // before you even click it — camera permission already denied, browser
  // doesn't even report permission state, etc. — instead of a silent
  // failure you have to guess at. (secureContext/hasGetUserMedia/platform
  // are static for the component's lifetime, so those are read once via
  // the staticDiagnostics memo above, not here.)
  useEffect(() => {
    let status: PermissionStatus | null = null;
    navigator.permissions
      ?.query({ name: 'camera' as PermissionName })
      .then((result) => {
        status = result;
        setCameraPermission(result.state);
        result.onchange = () => {
          setCameraPermission(result.state);
        };
      })
      .catch(() => {
        // Safari/iOS doesn't implement the Permissions API for "camera" —
        // that's itself useful information, not an error to hide.
        setCameraPermission('unsupported');
      });

    return () => {
      if (status) status.onchange = null;
    };
  }, []);

  // Standalone sanity check, deliberately decoupled from the QR/Opus
  // pipeline: proves (or disproves) that this device actually gets sound
  // from a Web Audio graph to its speakers at all — mute switch, silent
  // mode, output routing, an OS-level audio bug — before blaming decode.
  const [testToneState, setTestToneState] = useState<'idle' | 'playing' | 'error'>('idle');
  const testTone = useCallback(async () => {
    setTestToneState('playing');
    try {
      const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      if (ctx.state === 'suspended') await ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.2;
      osc.frequency.value = 880;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
      osc.onended = () => {
        void ctx.close();
        setTestToneState('idle');
      };
    } catch {
      setTestToneState('error');
    }
  }, []);

  const postSilenceFrame = useCallback(() => {
    workletNodeRef.current?.port.postMessage({ type: 'pcm', samples: new Float32Array(SAMPLES_PER_FRAME) });
  }, []);

  const pump = useCallback(() => {
    const jitterBuffer = jitterBufferRef.current;
    if (!jitterBuffer) return;
    const now = performance.now();
    if (!jitterBuffer.isReady(now)) return;

    const frame = jitterBuffer.pullFrame();
    const decoder = decoderRef.current;
    if (!frame || !frame.bytes || !decoder) {
      postSilenceFrame();
    } else {
      const { channelData, samplesDecoded, errors } = decoder.decodeFrame(frame.bytes);
      if (errors.length > 0 || samplesDecoded === 0) {
        postSilenceFrame();
      } else {
        const samples = channelData[0].slice(0, samplesDecoded);
        workletNodeRef.current?.port.postMessage({ type: 'pcm', samples }, [samples.buffer]);
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
      audioContext.addEventListener('statechange', () => setAudioContextState(audioContext.state));
      setAudioContextState(audioContext.state);
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

      // WASM Opus decoder (works on every browser, iOS/Safari included —
      // unlike WebCodecs' AudioDecoder, which WebKit doesn't support for
      // Opus). channels: 1 matches our mono encode; without it this
      // defaults to stereo and misreads our headerless raw frames.
      const decoder = new OpusDecoder({ channels: 1 }); // 48000 is already the library default
      await decoder.ready;
      decoderRef.current = decoder;

      rvfcHandleRef.current = video.requestVideoFrameCallback(onVideoFrame);
      pumpIntervalRef.current = setInterval(pump, PUMP_INTERVAL_MS);

      setStatus('listening');
    } catch (err) {
      stopEverything();
      setStatus('error');
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }, [handleWorkerMessage, onVideoFrame, pump, stopEverything]);

  const stop = useCallback(() => {
    stopEverything();
    setStatus('idle');
  }, [stopEverything]);

  return (
    <div className="relative z-10 mx-auto flex min-w-0 max-w-3xl flex-col gap-6 p-6">
      <h1 className="aero-title text-3xl font-extrabold tracking-tight">📷 QR Radio — Receptor</h1>

      <div className="aero-panel flex flex-col gap-2 p-4">
        <span className="text-sm font-bold text-(--aero-blue-dark)">Diagnóstico</span>
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
          <DiagStat
            label="contexto seguro (HTTPS)"
            {...(diagnostics.secureContext
              ? { text: 'sim', status: 'ok' as const }
              : { text: 'não — câmera vai falhar', status: 'bad' as const })}
          />
          <DiagStat
            label="suporte a câmera"
            {...(diagnostics.hasGetUserMedia
              ? { text: 'sim', status: 'ok' as const }
              : { text: 'não suportado', status: 'bad' as const })}
          />
          <DiagStat label="permissão de câmera" {...cameraPermissionDisplay(diagnostics.cameraPermission)} />
          <DiagStat label="AudioContext" {...audioContextDisplay(diagnostics.audioContextState)} />
          <DiagStat label="plataforma" text={diagnostics.platform} status="neutral" />
        </dl>
        <div className="mt-1 flex items-center gap-2">
          <button
            onClick={() => void testTone()}
            disabled={testToneState === 'playing'}
            className="aero-button aero-button-neutral text-sm"
          >
            {testToneState === 'playing' ? 'Tocando bipe…' : '🔊 Testar som (bipe de 0.4s)'}
          </button>
          <span className="text-xs font-medium text-(--aero-ink-soft)">
            Isolado do resto do app — se você não ouvir isso, o problema é volume/modo silencioso/roteamento do
            aparelho, não o decoder.
          </span>
        </div>
        {testToneState === 'error' && (
          <span className="text-xs font-medium text-(--aero-red-dark)">Nem o AudioContext do teste conseguiu iniciar.</span>
        )}
        {diagnostics.platform === 'ios' && (
          <span className="text-xs font-medium text-amber-700">
            iOS detectado — todo navegador aqui roda sobre WebKit (mesmo o Chrome). Testado com o decoder WASM, mas se
            não sair som mesmo com tudo verde acima, pode ser um limite do WebKit que eu ainda não vi.
          </span>
        )}
      </div>

      <video ref={videoRef} className="aero-screen mx-auto w-full max-w-md" muted playsInline />

      <div className="aero-panel flex items-center gap-4 p-4">
        {status !== 'listening' ? (
          <button onClick={() => void start()} disabled={status === 'starting'} className="aero-button aero-button-blue">
            {status === 'starting' ? 'Conectando…' : '🎧 Ouvir'}
          </button>
        ) : (
          <button onClick={stop} className="aero-button aero-button-red">
            ⏹ Parar
          </button>
        )}
        {status === 'error' && errorMessage && (
          <span className="text-sm font-medium text-(--aero-red-dark)">{errorMessage}</span>
        )}
      </div>

      <dl className="grid grid-cols-1 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
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
    <div className="aero-chip flex justify-between gap-2 px-3 py-2">
      <dt className="text-(--aero-ink-soft)">{label}</dt>
      <dd className="font-mono font-semibold text-(--aero-blue-dark)">{value}</dd>
    </div>
  );
}

type DiagStatus = 'ok' | 'warn' | 'bad' | 'neutral';

const DIAG_STATUS_CLASS: Record<DiagStatus, string> = {
  ok: 'text-(--aero-green-dark)',
  warn: 'text-amber-700',
  bad: 'text-(--aero-red-dark)',
  neutral: 'text-(--aero-ink)',
};

function DiagStat({ label, text, status }: { label: string; text: string; status: DiagStatus }) {
  return (
    <div className="aero-chip flex justify-between gap-2 px-3 py-2">
      <dt className="text-(--aero-ink-soft)">{label}</dt>
      <dd className={`font-mono font-semibold ${DIAG_STATUS_CLASS[status]}`}>{text}</dd>
    </div>
  );
}

function cameraPermissionDisplay(permission: PermissionCheck): { text: string; status: DiagStatus } {
  switch (permission) {
    case 'granted':
      return { text: 'concedida', status: 'ok' };
    case 'denied':
      return { text: 'negada — libere nas configurações do site', status: 'bad' };
    case 'prompt':
      return { text: 'ainda não pedida', status: 'warn' };
    case 'unsupported':
      return { text: 'navegador não informa (normal no Safari)', status: 'warn' };
    default:
      return { text: 'checando…', status: 'neutral' };
  }
}

function audioContextDisplay(state: Diagnostics['audioContextState']): { text: string; status: DiagStatus } {
  switch (state) {
    case 'running':
      return { text: 'tocando', status: 'ok' };
    case 'suspended':
      return { text: 'suspenso — sem som', status: 'bad' };
    case 'closed':
      return { text: 'fechado', status: 'warn' };
    default:
      return { text: 'não iniciado', status: 'neutral' };
  }
}
