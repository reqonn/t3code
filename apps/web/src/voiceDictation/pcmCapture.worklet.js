// Forwards microphone samples to the main thread in ~85 ms batches. Plain JS: worklet modules
// load by URL, and the desktop CSP only allows scripts from the app's own origin.
const BATCH_FRAMES = 4096;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Float32Array(BATCH_FRAMES);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    let offset = 0;
    while (offset < channel.length) {
      const count = Math.min(channel.length - offset, BATCH_FRAMES - this.filled);
      this.batch.set(channel.subarray(offset, offset + count), this.filled);
      this.filled += count;
      offset += count;
      if (this.filled === BATCH_FRAMES) {
        this.port.postMessage(this.batch, [this.batch.buffer]);
        this.batch = new Float32Array(BATCH_FRAMES);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
