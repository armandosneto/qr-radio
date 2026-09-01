'use client';

import dynamic from 'next/dynamic';

// `ssr: false` inside next/dynamic is only allowed from a Client Component,
// hence this one-line wrapper around the real (also client) EmitterClient.
const EmitterClient = dynamic(() => import('./EmitterClient'), { ssr: false });

export default EmitterClient;
