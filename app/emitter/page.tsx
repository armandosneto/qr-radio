import EmitterClient from './DynamicEmitter';

// EmitterClient touches canvas, WebCodecs and performance.now() at module
// scope during render — none of that exists during SSR, so it's loaded
// client-only via DynamicEmitter's ssr:false boundary.
export default function EmitterPage() {
  return <EmitterClient />;
}
