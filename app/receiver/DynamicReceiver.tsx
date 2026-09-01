'use client';

import dynamic from 'next/dynamic';

// Same reasoning as app/emitter/DynamicEmitter.tsx: ReceiverClient touches
// camera, AudioContext and Worker at mount time, none of which exist
// during SSR, and `ssr: false` must be called from a Client Component.
// `loading` reserves roughly the real page's shape so the client bundle
// mounting doesn't pop the whole page in at once.
const ReceiverClient = dynamic(() => import('./ReceiverClient'), { ssr: false, loading: ReceiverSkeleton });

function ReceiverSkeleton() {
  return (
    <div className="relative z-10 mx-auto flex min-w-0 max-w-3xl flex-col gap-6 p-6">
      <h1 className="aero-title text-3xl font-extrabold tracking-tight">📷 QR Radio — Receptor</h1>
      <div className="aero-panel h-56 animate-pulse p-4" />
      <div className="aero-screen mx-auto aspect-3/4 w-full max-w-md animate-pulse" />
      <div className="aero-panel h-16 animate-pulse p-4" />
    </div>
  );
}

export default ReceiverClient;
