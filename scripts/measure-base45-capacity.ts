/**
 * Fase 1 (a pedido do usuário, dentro da investigação da Fase 0): quantos
 * pacotes Opus de 20ms cabem por QR a 24kbps, comparando o payload binário
 * cru (byte mode) contra o mesmo payload passado por Base45 (alphanumeric
 * mode) — que resolveria a ambiguidade de codificação do BarcodeDetector
 * ao custo de mais capacidade de QR.
 */
import { getByteCapacity, getAlphanumericCapacity } from '../lib/qr-capacity';
import { base45EncodedLength, base45MaxBytesForChars, base45Encode, base45Decode } from '../lib/base45';
import { FIXED_OVERHEAD } from '../lib/protocol';

// --- autoteste do Base45 (round-trip), antes de confiar nos números ---
function selfTestBase45() {
  const cases = [
    new Uint8Array([]),
    new Uint8Array([0]),
    new Uint8Array([255]),
    Uint8Array.from({ length: 256 }, (_, i) => i),
    Uint8Array.from([0x51, 0x52, 1, 0, 42, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 21, 0, 5, 10, 20, 30, 40, 50]),
  ];
  for (const bytes of cases) {
    const encoded = base45Encode(bytes);
    const decoded = base45Decode(encoded);
    const ok = decoded.length === bytes.length && decoded.every((b, i) => b === bytes[i]);
    // também confere que a string só usa caracteres ASCII seguros
    const asciiSafe = [...encoded].every((c) => c.charCodeAt(0) < 128);
    if (!ok || !asciiSafe) {
      throw new Error(`Base45 self-test falhou pra tamanho ${bytes.length}: ok=${ok} asciiSafe=${asciiSafe}`);
    }
  }
  console.log('Base45 self-test (round-trip + ASCII-safety): OK\n');
}

selfTestBase45();

const VERSION = 25;
const ECC = 'M' as const;
const BITRATE_BPS = 24_000;
const FRAME_MS = 20;
const PACKET_BYTES_CBR = Math.round((BITRATE_BPS * (FRAME_MS / 1000)) / 8); // Opus CBR @ 24kbps, 20ms
const LEGACY_PER_PACKET_PREFIX = 2; // uint16 length prefix (atual, antes da Fase 1 item 5)
const CBR_HEADER_EXTRA = 3; // packetSize:2B + packetCount:1B, uma vez só (proposta Fase 1 item 5)

console.log(`Config: V${VERSION}/${ECC}, ${BITRATE_BPS / 1000}kbps CBR, pacote Opus = ${PACKET_BYTES_CBR} bytes (20ms)\n`);

const byteCapacity = getByteCapacity(VERSION, ECC);
const netPayloadByte = byteCapacity - FIXED_OVERHEAD;
console.log(`--- Byte mode ---`);
console.log(`Capacidade bruta do QR: ${byteCapacity} bytes`);
console.log(`Payload líquido (menos ${FIXED_OVERHEAD}B de header+CRC): ${netPayloadByte} bytes`);

const packetsLegacy = Math.floor(netPayloadByte / (PACKET_BYTES_CBR + LEGACY_PER_PACKET_PREFIX));
console.log(
  `  com prefixo de 2B por pacote (atual):        ${packetsLegacy} pacotes/QR = ${packetsLegacy * FRAME_MS}ms de áudio/QR`,
);
const packetsCbrHeader = Math.floor((netPayloadByte - CBR_HEADER_EXTRA) / PACKET_BYTES_CBR);
console.log(
  `  sem prefixo por pacote (Fase 1 item 5, CBR):  ${packetsCbrHeader} pacotes/QR = ${packetsCbrHeader * FRAME_MS}ms de áudio/QR`,
);

console.log(`\n--- Base45 (alphanumeric mode) ---`);
const alphaCapacityChars = getAlphanumericCapacity(VERSION, ECC);
console.log(`Capacidade bruta do QR: ${alphaCapacityChars} caracteres alfanuméricos`);

const maxWireBytesBase45 = base45MaxBytesForChars(alphaCapacityChars);
console.log(
  `Bytes de payload de protocolo (header+CRC inclusos) que cabem via Base45: ${maxWireBytesBase45} bytes ` +
    `(codificam pra ${base45EncodedLength(maxWireBytesBase45)} chars, limite é ${alphaCapacityChars})`,
);
const netPayloadBase45 = maxWireBytesBase45 - FIXED_OVERHEAD;
console.log(`Payload líquido (menos ${FIXED_OVERHEAD}B de header+CRC): ${netPayloadBase45} bytes`);

const packetsBase45Legacy = Math.floor(netPayloadBase45 / (PACKET_BYTES_CBR + LEGACY_PER_PACKET_PREFIX));
console.log(
  `  com prefixo de 2B por pacote:                 ${packetsBase45Legacy} pacotes/QR = ${packetsBase45Legacy * FRAME_MS}ms de áudio/QR`,
);
const packetsBase45Cbr = Math.floor((netPayloadBase45 - CBR_HEADER_EXTRA) / PACKET_BYTES_CBR);
console.log(
  `  sem prefixo por pacote (CBR):                 ${packetsBase45Cbr} pacotes/QR = ${packetsBase45Cbr * FRAME_MS}ms de áudio/QR`,
);

console.log(`\n--- Overhead real do Base45 vs byte mode (mesmo cenário CBR) ---`);
const overheadPct = (1 - packetsBase45Cbr / packetsCbrHeader) * 100;
console.log(
  `${packetsCbrHeader} pacotes (byte mode) -> ${packetsBase45Cbr} pacotes (Base45): ${overheadPct.toFixed(1)}% menos pacotes/QR`,
);
