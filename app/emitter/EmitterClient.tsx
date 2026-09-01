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
      }).catch((err) => {
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
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">QR Radio — Emissor</h1>

      {!webCodecsOk && (
        <div className="rounded border border-amber-400 bg-amber-50 p-3 text-sm text-amber-900">
          Este navegador não suporta WebCodecs AudioEncoder(opus) (necessário Chrome/Edge). O encode client-side não vai
          funcionar aqui.
        </div>
      )}

      <div className="flex flex-col gap-2">
        <input type="file" accept=".mp3,.wav,.m4a,.flac,audio/*" onChange={onFileInputChange} />
        {fileName && <span className="text-sm text-gray-600">{fileName}</span>}
        {status === 'encoding' && (
          <div className="h-2 w-full overflow-hidden rounded bg-gray-200">
            <div className="h-full bg-blue-500 transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
        {displayStatus === 'error' && displayError && <div className="text-sm text-red-600">{displayError}</div>}
      </div>

      <canvas ref={canvasRef} className="mx-auto rounded border border-gray-300" />

      <div className="flex flex-wrap items-center gap-4">
        <button
          onClick={togglePlay}
          disabled={!packetizeResult}
          className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-40"
        >
          {playing ? 'Pause' : 'Play'}
        </button>

        <label className="flex items-center gap-2 text-sm">
          fps
          <input
            type="range"
            min={5}
            max={15}
            value={fps}
            onChange={(e) => setFps(Number(e.target.value))}
          />
          {fps}
        </label>

        <label className="flex items-center gap-2 text-sm">
          versão QR
          <select value={qrVersion} onChange={(e) => setQrVersion(Number(e.target.value))}>
            {QR_VERSIONS.map((v) => (
              <option key={v} value={v}>
                V{v}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-sm">
          ECC
          <select value={ecc} onChange={(e) => setEcc(e.target.value as EccLevel)}>
            {ECC_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        posição
        <input
          type="range"
          min={0}
          max={Math.max(totalDurationMs, 1)}
          value={Math.min(positionMs, totalDurationMs)}
          onChange={onSeek}
          disabled={!packetizeResult}
        />
      </label>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
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
    <div className="flex justify-between gap-2 rounded bg-gray-100 px-2 py-1">
      <dt className="text-gray-600">{label}</dt>
      <dd className="font-mono font-semibold text-gray-900">{value}</dd>
    </div>
  );
}
