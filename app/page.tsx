import Link from 'next/link';

export default function Home() {
  return (
    <div className="relative z-10 flex flex-1 flex-col items-center justify-center gap-10 px-6 py-20 text-center">
      <div className="flex flex-col items-center gap-3">
        <span className="aero-chip px-4 py-1 text-xs font-semibold tracking-wide text-(--aero-blue-dark) uppercase">
          rádio sem rede
        </span>
        <h1 className="aero-title text-5xl font-extrabold tracking-tight sm:text-6xl">QR Radio</h1>
        {/* --aero-ink-soft reads fine inside a glass panel (it's tuned for
            that), but this paragraph sits directly on the raw sky gradient
            — against the mid-brightness band of it, that color measures
            under WCAG AA contrast (~3:1). --aero-ink is dark enough to
            clear AA against the gradient's darkest point, so it's used
            here instead; the text-shadow adds a bit more separation on
            top of that, same trick as the title above it. */}
        <p
          className="max-w-md text-base font-medium text-(--aero-ink)"
          style={{ textShadow: '0 1px 2px rgba(255,255,255,0.6)' }}
        >
          Áudio transmitido em tempo real por uma sequência de QR codes na tela — sem Wi-Fi, sem Bluetooth, sem
          servidor no meio. Aponte a câmera e ouça de onde o emissor estiver.
        </p>
      </div>

      <div className="flex flex-col gap-6 sm:flex-row">
        <Link href="/emitter" className="aero-panel flex w-64 flex-col items-center gap-3 px-8 py-8">
          <span className="text-4xl">📡</span>
          <span className="text-lg font-bold text-(--aero-blue-dark)">Emissor</span>
          <span className="text-sm text-(--aero-ink-soft)">Carrega um áudio e transmite via QR na tela</span>
          <span className="aero-button aero-button-blue mt-2 w-full text-sm">Abrir emissor</span>
        </Link>

        <Link href="/receiver" className="aero-panel flex w-64 flex-col items-center gap-3 px-8 py-8">
          <span className="text-4xl">📷</span>
          <span className="text-lg font-bold text-(--aero-blue-dark)">Receptor</span>
          <span className="text-sm text-(--aero-ink-soft)">Aponta a câmera pro emissor e ouve na hora</span>
          <span className="aero-button aero-button-green mt-2 w-full text-sm">Abrir receptor</span>
        </Link>
      </div>
    </div>
  );
}
