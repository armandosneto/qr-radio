// AudioWorkletProcessor — the actual audio-thread ring buffer + adaptive
// resampler. Loaded via audioContext.audioWorklet.addModule('/ring-buffer-processor.js'),
// so this stays plain JS (no bundler in the loop): see lib/jitter-buffer.ts
// for the segment-level jitter buffer this sits downstream of.
//
// Two independent buffers exist in this system, and it's worth being
// explicit about why: the JitterBuffer (main thread) absorbs QR-arrival
// jitter — camera frames landing whenever they land, ~1s deep. This ring
// buffer absorbs a much smaller, faster kind of jitter — the gap between
// "the main thread decided to post a 20ms PCM chunk" and "the audio thread
// actually needs it," which is governed by setInterval/message-passing
// timing, not network-style jitter. It only needs a few hundred ms of
// cushion, not a full second.
//
// Clock drift correction: the emitter produces audio at its own rate: this
// device's DAC consumes at its own (slightly different) rate. Nothing
// keeps those two clocks locked, so over minutes the ring buffer would
// either drain (underrun -> silence) or fill up (overflow -> unbounded
// latency growth) without correction. Each render quantum nudges the
// playback rate by up to +-0.5% based on how far the buffer occupancy is
// from a target cushion, resampled via simple linear interpolation.

class RingBufferProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacitySamples = Math.round(sampleRate * 5); // 5s ceiling, generous
    this.ring = new Float32Array(this.capacitySamples);
    this.writeIndex = 0;
    this.readIndexF = 0; // fractional read position
    this.totalWritten = 0;
    this.totalRead = 0; // fractional, tracks resampled consumption
    this.reportAccumulator = 0;
    this.targetSamples = sampleRate * 0.3; // 300ms cushion

    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  handleMessage(msg) {
    if (msg.type === 'pcm') {
      this.write(msg.samples);
    } else if (msg.type === 'reset') {
      this.writeIndex = 0;
      this.readIndexF = 0;
      this.totalWritten = 0;
      this.totalRead = 0;
    }
  }

  write(samples) {
    const cap = this.capacitySamples;
    for (let i = 0; i < samples.length; i++) {
      this.ring[this.writeIndex] = samples[i];
      this.writeIndex = (this.writeIndex + 1) % cap;
    }
    this.totalWritten += samples.length;
  }

  process(_inputs, outputs) {
    const channel = outputs[0][0];
    const n = channel.length;
    const cap = this.capacitySamples;

    const available = Math.max(0, this.totalWritten - this.totalRead);
    const errorSeconds = (available - this.targetSamples) / sampleRate;
    const rate = 1 + Math.max(-0.005, Math.min(0.005, errorSeconds * 0.02));

    for (let i = 0; i < n; i++) {
      const availableNow = this.totalWritten - this.totalRead;
      if (availableNow < 2) {
        channel[i] = 0; // underrun — never block, just go quiet for this sample
        continue;
      }
      const i0 = Math.floor(this.readIndexF) % cap;
      const i1 = (i0 + 1) % cap;
      const frac = this.readIndexF - Math.floor(this.readIndexF);
      channel[i] = this.ring[i0] * (1 - frac) + this.ring[i1] * frac;

      this.readIndexF += rate;
      if (this.readIndexF >= cap) this.readIndexF -= cap;
      this.totalRead += rate;
    }

    this.reportAccumulator += n;
    if (this.reportAccumulator >= sampleRate * 0.25) {
      this.reportAccumulator = 0;
      const bufferedMs = (Math.max(0, this.totalWritten - this.totalRead) / sampleRate) * 1000;
      this.port.postMessage({ type: 'stats', bufferedMs, rate });
    }

    return true;
  }
}

registerProcessor('ring-buffer-processor', RingBufferProcessor);
