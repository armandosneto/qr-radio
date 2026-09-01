'use client';

import dynamic from 'next/dynamic';

// Same reasoning as app/emitter/DynamicEmitter.tsx: ReceiverClient touches
// camera, AudioContext and Worker at mount time, none of which exist
// during SSR, and `ssr: false` must be called from a Client Component.
const ReceiverClient = dynamic(() => import('./ReceiverClient'), { ssr: false });

export default ReceiverClient;
