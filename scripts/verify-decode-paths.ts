/**
 * Fase 0 — verificação de corrupção de bytes no caminho nativo (BarcodeDetector).
 *
 * Duas partes:
 *
 * A) jsQR ponta a ponta, sem navegador: gera QR (via QRCode.create, sem
 *    depender do pacote nativo `canvas`), rasteriza os módulos manualmente
 *    em pixels RGBA (replicando a lógica de renderer/utils.js: scale=8,
 *    margin=4), decodifica com jsQR, compara byte a byte.
 *
 * B) BarcodeDetector NÃO é testável neste ambiente: confirmado nesta mesma
 *    sessão (Chromium headless usado no Playwright aqui não expõe
 *    `BarcodeDetector`, nem em Window nem em Worker — ver conversa anterior
 *    sobre o teste da câmera falsa). Em vez de pular a pergunta, este script
 *    testa a LÓGICA de lib/qr-decoder-worker.ts (`latin1StringToBytes`)
 *    contra duas hipóteses de como o navegador poderia ter decodificado
 *    `rawValue`:
 *      - hipótese ISO-8859-1 (o que o código assume)
 *      - hipótese UTF-8 com fallback (comportamento documentado em algumas
 *        versões do ZXing para segmentos byte-mode sem marcador ECI)
 *    e mostra se o safety check atual (`code > 0xff`) pega os casos onde a
 *    segunda hipótese produziria bytes errados.
 */
import QRCode from 'qrcode';
import jsQR from 'jsqr';

// ---------------------------------------------------------------------------
// Parte A — jsQR ponta a ponta
// ---------------------------------------------------------------------------

function rasterizeQr(bytes: Uint8Array, version: number | undefined, ecc: 'L' | 'M' | 'Q' | 'H') {
  const qr = QRCode.create([{ data: bytes, mode: 'byte' }], { version, errorCorrectionLevel: ecc });
  const size = qr.modules.size;
  const scale = 8;
  const margin = 4;
  const symbolSize = (size + margin * 2) * scale;

  const pixels = new Uint8ClampedArray(symbolSize * symbolSize * 4);
  pixels.fill(255); // white background (quiet zone + light modules)

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const dark = qr.modules.get(row, col);
      if (!dark) continue;
      const px0 = (col + margin) * scale;
      const py0 = (row + margin) * scale;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const idx = ((py0 + dy) * symbolSize + (px0 + dx)) * 4;
          pixels[idx] = 0;
          pixels[idx + 1] = 0;
          pixels[idx + 2] = 0;
          pixels[idx + 3] = 255;
        }
      }
    }
  }
  return { pixels, width: symbolSize, height: symbolSize };
}

function bytesEqual(a: Uint8Array | number[], b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function partA() {
  console.log('=== Parte A: jsQR ponta a ponta (encode -> rasteriza -> jsQR.decode) ===\n');

  const cases: { name: string; bytes: Uint8Array }[] = [
    { name: 'todos os bytes 0x00-0xFF em sequência', bytes: Uint8Array.from({ length: 256 }, (_, i) => i) },
    { name: 'só 0x00', bytes: new Uint8Array(30).fill(0x00) },
    { name: 'só 0xFF', bytes: new Uint8Array(30).fill(0xff) },
    {
      name: 'sequência UTF-8 inválida (continuation bytes soltos)',
      bytes: Uint8Array.from([0x80, 0x81, 0xbf, 0xc0, 0xc1, 0xfe, 0xff, 0x00, 0x41, 0x42]),
    },
    {
      name: 'padrão adversarial C2/C3 + continuation (ver Parte B)',
      bytes: Uint8Array.from([0xc2, 0x80, 0xc3, 0xbf, 0xc2, 0xa9, 0x41, 0xc3, 0x80, 0x00]),
    },
    {
      name: 'payload real de protocolo (header + opus fake)',
      bytes: Uint8Array.from([
        0x51, 0x52, 1, 0, 42, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 21, 0, 5, 10, 20, 30, 40, 50, 0, 5, 60, 70, 80, 90, 100, 0,
        5, 110, 120, 130, 140, 150, 91, 215, 208, 230,
      ]),
    },
  ];

  let allPass = true;
  for (const { name, bytes } of cases) {
    try {
      const { pixels, width, height } = rasterizeQr(bytes, undefined, 'M');
      const result = jsQR(pixels, width, height, { inversionAttempts: 'dontInvert' });
      if (!result) {
        console.log(`✗ ${name}: jsQR não decodificou nada`);
        allPass = false;
        continue;
      }
      const ok = bytesEqual(result.binaryData, bytes);
      console.log(`${ok ? '✓' : '✗'} ${name}: ${ok ? 'bytes idênticos' : 'DIVERGIU — ' + JSON.stringify(result.binaryData) + ' vs ' + JSON.stringify(Array.from(bytes))}`);
      if (!ok) allPass = false;
    } catch (err) {
      console.log(`✗ ${name}: erro — ${err instanceof Error ? err.message : String(err)}`);
      allPass = false;
    }
  }
  console.log(`\nParte A: ${allPass ? 'TODOS OS CASOS PASSARAM' : 'HÁ DIVERGÊNCIA'}\n`);
  return allPass;
}

// ---------------------------------------------------------------------------
// Parte B — validação lógica de latin1StringToBytes contra duas hipóteses
// ---------------------------------------------------------------------------

// Copiado literalmente de lib/qr-decoder-worker.ts — mesma função, mesmo comportamento.
function latin1StringToBytes(s: string): Uint8Array | null {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code > 0xff) return null;
    out[i] = code;
  }
  return out;
}

function simulateIso88591Decode(bytes: Uint8Array): string {
  // ISO-8859-1 / Latin-1: mapeamento 1:1 byte -> code point. Exatamente o
  // que a String.fromCharCode faz aqui.
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

function simulateUtf8DecodeWithFallback(bytes: Uint8Array): string {
  // TextDecoder('utf-8') com fatal:false substitui sequências inválidas por
  // U+FFFD — é o comportamento mais próximo de um decodificador "tenta UTF-8,
  // não trava se malformado" sem ser um algoritmo de detecção customizado.
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function partB() {
  console.log('=== Parte B: latin1StringToBytes sob as duas hipóteses de decodificação ===\n');

  const cases: { name: string; bytes: Uint8Array }[] = [
    { name: 'todos os bytes 0x00-0xFF em sequência', bytes: Uint8Array.from({ length: 256 }, (_, i) => i) },
    {
      name: 'sequência UTF-8 inválida (continuation bytes soltos)',
      bytes: Uint8Array.from([0x80, 0x81, 0xbf, 0xc0, 0xc1, 0xfe, 0xff, 0x00, 0x41, 0x42]),
    },
    {
      name: 'C2/C3 + continuation válido — DECODE UTF-8 SUCEDE E FICA <=0xFF',
      bytes: Uint8Array.from([0xc2, 0x80, 0xc3, 0xbf, 0xc2, 0xa9, 0x41, 0xc3, 0x80, 0x00]),
    },
    {
      name: 'payload real de protocolo (header + opus fake)',
      bytes: Uint8Array.from([
        0x51, 0x52, 1, 0, 42, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 21, 0, 5, 10, 20, 30, 40, 50, 0, 5, 60, 70, 80, 90, 100, 0,
        5, 110, 120, 130, 140, 150, 91, 215, 208, 230,
      ]),
    },
  ];

  for (const { name, bytes } of cases) {
    const isoString = simulateIso88591Decode(bytes);
    const isoRecovered = latin1StringToBytes(isoString);
    const isoOk = isoRecovered !== null && bytesEqual(isoRecovered, bytes);

    const utf8String = simulateUtf8DecodeWithFallback(bytes);
    const utf8Recovered = latin1StringToBytes(utf8String);
    const utf8SilentlyAccepted = utf8Recovered !== null;
    const utf8Correct = utf8SilentlyAccepted && bytesEqual(utf8Recovered!, bytes);

    console.log(`--- ${name} ---`);
    console.log(`  original:            [${Array.from(bytes).join(',')}]`);
    console.log(`  hipótese ISO-8859-1 -> latin1StringToBytes: ${isoOk ? 'OK, recupera exatamente' : 'FALHA'}`);
    console.log(
      `  hipótese UTF-8(fallback) -> latin1StringToBytes: ` +
        (!utf8SilentlyAccepted
          ? 'rejeitado pelo safety check (code>0xff) — comportamento seguro'
          : utf8Correct
            ? 'aceito e correto (coincidência: string idêntica à ISO-8859-1)'
            : `ACEITO SILENCIOSAMENTE E ERRADO -> [${Array.from(utf8Recovered!).join(',')}]`),
    );
    console.log('');
  }
}

partA();
partB();
