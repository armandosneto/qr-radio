/**
 * Server-side fallback encoder: decode(ffmpeg-static) -> PCM -> Opus(opusscript).
 *
 * The emitter's primary path encodes entirely client-side with WebCodecs
 * (see lib/opus-client-encoder.ts) and never touches this route — that's
 * the only path that survives Vercel's platform request-body size limit
 * (4.5MB on serverless Functions, not configurable from app code). This
 * route exists for browsers without WebCodecs `AudioEncoder` (Safari,
 * Firefox): it works, but is only realistic for short clips given that
 * limit. A production fix would upload the file to blob storage first and
 * have this route pull from there instead of the request body.
 */
import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import { mkdtemp, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
// opusscript ships no type declarations.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const OpusScript = require('opusscript');

export const runtime = 'nodejs';
export const maxDuration = 300;

const SAMPLE_RATE = 48000;
const FRAME_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_MS) / 1000; // 960
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * 2; // s16le mono

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'missing "file" field' }, { status: 400 });
  }

  const bitrateRaw = form.get('bitrate');
  const bitrate = typeof bitrateRaw === 'string' && Number(bitrateRaw) > 0 ? Number(bitrateRaw) : 40_000;

  const dir = await mkdtemp(path.join(tmpdir(), 'qr-radio-'));
  // Fixed filename (not derived from the upload) — ffmpeg probes the
  // container/codec from content, not the extension, and this keeps the
  // path statically analyzable instead of pulling the whole project into
  // the serverless bundle's file trace.
  const inputPath = path.join(dir, 'input');

  try {
    await writeFile(inputPath, new Uint8Array(await file.arrayBuffer()));
    const pcm = await decodeToPcm(inputPath);
    const packets = encodeOpus(pcm, bitrate);
    const durationMs = (pcm.length / 2 / SAMPLE_RATE) * 1000;

    return NextResponse.json({
      durationMs,
      frameMs: FRAME_MS,
      sampleRate: SAMPLE_RATE,
      packets: packets.map((p) => Buffer.from(p).toString('base64')),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await unlink(inputPath).catch(() => {});
  }
}

function decodeToPcm(inputPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error('ffmpeg-static binary not found'));
      return;
    }
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      inputPath,
      '-f',
      's16le',
      '-ac',
      '1',
      '-ar',
      String(SAMPLE_RATE),
      'pipe:1',
    ];
    const proc = spawn(ffmpegPath, args);
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exited with code ${code}: ${Buffer.concat(errChunks).toString('utf8')}`));
    });
  });
}

function encodeOpus(pcm: Buffer, bitrate: number): Uint8Array[] {
  const encoder = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.AUDIO);
  encoder.setBitrate(bitrate);

  const packets: Uint8Array[] = [];
  let offset = 0;
  while (offset < pcm.length) {
    let frame: Buffer;
    if (offset + BYTES_PER_FRAME <= pcm.length) {
      frame = pcm.subarray(offset, offset + BYTES_PER_FRAME);
    } else {
      // Pad the final partial frame with silence — Opus needs fixed-size frames.
      frame = Buffer.alloc(BYTES_PER_FRAME);
      pcm.copy(frame, 0, offset);
    }
    const packet: Buffer = encoder.encode(frame, SAMPLES_PER_FRAME);
    packets.push(new Uint8Array(packet));
    offset += BYTES_PER_FRAME;
  }

  encoder.delete();
  return packets;
}
