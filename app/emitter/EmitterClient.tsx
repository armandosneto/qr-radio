'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { encodePacket, PROTOCOL_VERSION } from '@/lib/protocol';
import { packetize, maxPayloadFromQrCapacity, type PacketizeResult } from '@/lib/packetizer';
import { getByteCapacity, type EccLevel } from '@/lib/qr-capacity';
import { encodeFileToOpusPackets, isOpusEncodeSupported, type EncodeResult } from '@/lib/opus-client-encoder';

const SEGMENT_MS = 400;
const ECC_LEVELS: EccLevel[] = ['L', 'M', 'Q', 'H'];
const QR_VERSIONS = [15, 20, 25, 30, 35, 40];

type Status = 'idle' | 'encoding' | 'ready' | 'error';

interface Hud {
  seq: number;
  isRepeat: boolean;
  actualFps: number;
  bytesPerFrame: number;
  throughputKbps: number;
}

export default function EmitterClient() {
  const [status, setStatus] = useState<Status>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  const [encodeResult, setEncodeResult] = useState<EncodeResult | null>(null);

  const [playing, setPlaying] = useState(false);
  const [fps, setFps] = useState(10);
  const [qrVersion, setQrVersion] = useState(25);
  const [ecc, setEcc] = useState<EccLevel>('M');
  const [positionMs, setPositionMs] = useState(0);

  const [hud, setHud] = useState<Hud>({ seq: 0, isRepeat: false, actualFps: 0, bytesPerFrame: 0, throughputKbps: 0 });

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasWrapperRef = useRef<HTMLDivElement>(null);
  const streamIdRef = useRef(0);
  const streamStartRef = useRef(0);
  const schedulePointerRef = useRef(0);
  const lastElapsedRef = useRef(0);
  const tickHistoryRef = useRef<{ t: number; bytes: number }[]>([]);
  const webCodecsOk = useMemo(() => isOpusEncodeSupported(), []);

  // Re-packetize (pure computation) whenever the encoded audio or the QR
  // budget (version/ECC) changes. maxPayloadBytes too small for the current
  // Opus bitrate surfaces as a thrown error from packetize().
  const { packetizeResult, packetizeError } = useMemo(() => {
    if (!encodeResult) return { packetizeResult: null, packetizeError: null };
    try {
      const capacity = getByteCapacity(qrVersion, ecc);
      const maxPayloadBytes = maxPayloadFromQrCapacity(capacity);
      const result = packetize(encodeResult.packets, {
        segmentMs: SEGMENT_MS,
        frameMs: encodeResult.frameMs,
        maxPayloadBytes,
      });
      return { packetizeResult: result as PacketizeResult, packetizeError: null as string | null };
    } catch (err) {
      return {
        packetizeResult: null as PacketizeResult | null,
        packetizeError: err instanceof Error ? err.message : String(err),
      };
    }
  }, [encodeResult, qrVersion, ecc]);

  // Reset playback position/pointer bookkeeping (refs only, no setState) whenever
  // the segment layout changes underneath the render loop.
  useEffect(() => {
    schedulePointerRef.current = 0;
    lastElapsedRef.current = 0;
    streamStartRef.current = performance.now();
  }, [packetizeResult]);

  const displayStatus: Status = packetizeError ? 'error' : status;
  const displayError = packetizeError ?? errorMessage;

  // A <canvas> is a replaced element: browsers size its CSS box from
  // width/height *pixel attributes* first. QRCode.toCanvas mutates those
  // attributes on every redraw (each QR needs its own module count/pixel
  // size), and — inside a flex layout — that mutation can retroactively
  // perturb an ancestor's own `aspect-ratio`-derived size too (a replaced
  // descendant's intrinsic ratio can feed back into a flex-item ancestor's
  // sizing). CSS alone couldn't hold a stable square through that, so the
  // canvas's pixel size is pinned directly via inline style instead of any
  // CSS mechanism, and reapplied after every single redraw — not just on
  // wrapper resize — so a mid-draw attribute mutation can never leave it
  // momentarily incorrect.
  const applyCanvasSizeRef = useRef<(size: number) => void>(() => {});
  useEffect(() => {
    const wrapper = canvasWrapperRef.current;
    const canvas = canvasRef.current;
    if (!wrapper || !canvas) return;

    const applySize = (size: number) => {
      canvas.style.width = `${size}px`;
      canvas.style.height = `${size}px`;
    };
    applyCanvasSizeRef.current = applySize;
    applySize(wrapper.getBoundingClientRect().width);

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) applySize(width);
    });
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, []);

  const handleFile = useCallback(async (file: File) => {
    setStatus('encoding');
    setErrorMessage(null);
    setFileName(file.name);
    setProgress(0);
    setPlaying(false);

    try {
      if (!webCodecsOk) {
        throw new Error(
          'Este navegador não tem WebCodecs AudioEncoder(opus). Use Chrome/Edge, ou implemente o fallback via /api/encode.',
        );
      }
      const result = await encodeFileToOpusPackets(file, 40_000, (p) => {
        setProgress(p.totalMs > 0 ? p.processedMs / p.totalMs : 0);
      });
      streamIdRef.current = (streamIdRef.current + 1) & 0xffff;
      setEncodeResult(result);
      setPositionMs(0);
      setStatus('ready');
    } catch (err) {
      setStatus('error');
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }, [webCodecsOk]);

  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
  };

  // Render loop.
  useEffect(() => {
    if (!playing || !packetizeResult || packetizeResult.schedule.length === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const totalMs = packetizeResult.totalDurationMs;
    const schedule = packetizeResult.schedule;
    const segments = packetizeResult.segments;

    const interval = setInterval(() => {
      const now = performance.now();
      const rawElapsed = now - streamStartRef.current;
      const elapsed = totalMs > 0 ? ((rawElapsed % totalMs) + totalMs) % totalMs : 0;

      if (elapsed < lastElapsedRef.current) {
        schedulePointerRef.current = 0; // wrapped around — loop back to the start
      }
      lastElapsedRef.current = elapsed;

      let pointer = schedulePointerRef.current;
      while (pointer + 1 < schedule.length && schedule[pointer + 1].dueAtMs <= elapsed) {
        pointer++;
      }
      schedulePointerRef.current = pointer;

      const entry = schedule[pointer];
      const segment = segments[entry.seq];
      const wireBytes = encodePacket(
        {
          version: PROTOCOL_VERSION,
          streamId: streamIdRef.current,
          seq: segment.seq,
          timestampMs: segment.timestampMs,
          isRepeat: entry.isRepeat,
        },
        segment.opusPackets,
      );

      QRCode.toCanvas(canvas, [{ data: wireBytes, mode: 'byte' }], {
        version: qrVersion,
        errorCorrectionLevel: ecc,
        margin: 2,
      })
        .then(() => {
          const wrapper = canvasWrapperRef.current;
          if (wrapper) applyCanvasSizeRef.current(wrapper.getBoundingClientRect().width);
        })
        .catch((err) => {
          setStatus('error');
          setErrorMessage(err instanceof Error ? err.message : String(err));
        });

      const history = tickHistoryRef.current;
      history.push({ t: now, bytes: wireBytes.length });
      while (history.length > 0 && now - history[0].t > 1000) history.shift();
      const bytesInWindow = history.reduce((sum, h) => sum + h.bytes, 0);

      setHud({
        seq: segment.seq,
        isRepeat: entry.isRepeat,
        actualFps: history.length,
        bytesPerFrame: wireBytes.length,
        throughputKbps: (bytesInWindow * 8) / 1000,
      });
      setPositionMs(elapsed);
    }, 1000 / fps);

    return () => clearInterval(interval);
  }, [playing, packetizeResult, fps, qrVersion, ecc]);

  const togglePlay = () => {
    if (!packetizeResult) return;
    if (!playing) {
      streamStartRef.current = performance.now() - positionMs;
      lastElapsedRef.current = positionMs;
    }
    setPlaying((p) => !p);
  };

  const onSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const ms = Number(e.target.value);
    setPositionMs(ms);
    streamStartRef.current = performance.now() - ms;
    lastElapsedRef.current = ms;
    schedulePointerRef.current = 0;
  };

  const totalDurationMs = packetizeResult?.totalDurationMs ?? 0;

  return (
    <div className="relative z-10 mx-auto flex min-w-0 max-w-3xl flex-col gap-6 p-6">
      <h1 className="aero-title text-3xl font-extrabold tracking-tight">📡 QR Radio — Emissor</h1>

      {!webCodecsOk && (
        <div className="aero-panel border-amber-300/70 p-3 text-sm font-medium text-amber-900">
          Este navegador não suporta WebCodecs AudioEncoder(opus) (necessário Chrome/Edge). O encode client-side não vai
          funcionar aqui.
        </div>
      )}

      <div className="aero-panel flex min-w-0 flex-col gap-2 p-4">
        <label className="aero-button aero-button-blue w-fit cursor-pointer">
          📂 Escolher arquivo
          <input
            type="file"
            accept=".mp3,.wav,.m4a,.flac,audio/*"
            onChange={onFileInputChange}
            className="sr-only"
          />
        </label>
        {fileName && <span className="text-sm font-medium break-all text-(--aero-ink-soft)">{fileName}</span>}
        {status === 'encoding' && (
          <div className="h-2 w-full overflow-hidden rounded-full bg-white/60 shadow-inner">
            <div
              className="h-full rounded-full bg-linear-to-r from-(--aero-cyan) to-(--aero-blue) transition-all"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        )}
        {displayStatus === 'error' && displayError && <div className="text-sm font-medium text-(--aero-red-dark)">{displayError}</div>}
      </div>

      <div ref={canvasWrapperRef} className="mx-auto w-full max-w-125">
        <canvas ref={canvasRef} className="aero-screen" />
      </div>

      <div className="aero-panel flex flex-wrap items-center gap-4 p-4">
        <button onClick={togglePlay} disabled={!packetizeResult} className="aero-button aero-button-blue">
          {playing ? '⏸ Pause' : '▶ Play'}
        </button>

        <label className="flex items-center gap-2 text-sm font-semibold text-(--aero-ink)">
          fps
          <input
            type="range"
            min={5}
            max={15}
            value={fps}
            onChange={(e) => setFps(Number(e.target.value))}
            className="aero-range w-24"
          />
          {fps}
        </label>

        <label className="flex items-center gap-2 text-sm font-semibold text-(--aero-ink)">
          versão QR
          <select value={qrVersion} onChange={(e) => setQrVersion(Number(e.target.value))} className="aero-select">
            {QR_VERSIONS.map((v) => (
              <option key={v} value={v}>
                V{v}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-sm font-semibold text-(--aero-ink)">
          ECC
          <select value={ecc} onChange={(e) => setEcc(e.target.value as EccLevel)} className="aero-select">
            {ECC_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="aero-panel flex flex-col gap-1 p-4 text-sm font-semibold text-(--aero-ink)">
        posição
        <input
          type="range"
          min={0}
          max={Math.max(totalDurationMs, 1)}
          value={Math.min(positionMs, totalDurationMs)}
          onChange={onSeek}
          disabled={!packetizeResult}
          className="aero-range w-full"
        />
      </label>

      <dl className="grid grid-cols-1 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
        <HudStat label="seq atual" value={`${hud.seq}${hud.isRepeat ? ' (repeat)' : ''}`} />
        <HudStat label="fps real" value={hud.actualFps.toFixed(0)} />
        <HudStat label="bytes/frame" value={`${hud.bytesPerFrame} B`} />
        <HudStat label="throughput" value={`${hud.throughputKbps.toFixed(1)} kbps`} />
        <HudStat label="segmentos" value={String(packetizeResult?.segments.length ?? 0)} />
        <HudStat label="duração total" value={`${(totalDurationMs / 1000).toFixed(1)} s`} />
      </dl>
    </div>
  );
}

function HudStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="aero-chip flex justify-between gap-2 px-3 py-2">
      <dt className="text-(--aero-ink-soft)">{label}</dt>
      <dd className="font-mono font-semibold text-(--aero-blue-dark)">{value}</dd>
    </div>
  );
}
