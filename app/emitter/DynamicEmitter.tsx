'use client';

import dynamic from 'next/dynamic';

// `ssr: false` inside next/dynamic is only allowed from a Client Component,
// hence this one-line wrapper around the real (also client) EmitterClient.
// `loading` reserves roughly the real page's shape (title + a square canvas
// area is by far the biggest element) so mounting the client bundle doesn't
// pop the whole page in at once — that's the layout shift that actually
// matters here, since nothing renders at all until this chunk loads.
const EmitterClient = dynamic(() => import('./EmitterClient'), { ssr: false, loading: EmitterSkeleton });

function EmitterSkeleton() {
  return (
    <div className="relative z-10 mx-auto flex min-w-0 max-w-3xl flex-col gap-6 p-6">
      <h1 className="aero-title text-3xl font-extrabold tracking-tight">📡 QR Radio — Emissor</h1>
      <div className="aero-panel h-16 animate-pulse p-4" />
      <div className="aero-screen mx-auto aspect-square w-full max-w-125 animate-pulse" />
      <div className="aero-panel h-16 animate-pulse p-4" />
    </div>
  );
}

export default EmitterClient;
