import { SPEECH_SAMPLE_RATE } from "./micCapture";

const FRAME = SPEECH_SAMPLE_RATE / 50; // 20 ms
const MIN_SPEECH_FRAMES = 8; // 160 ms
const PAUSE_FRAMES = 25; // 500 ms
const MIN_COMMIT_SAMPLES = 3 * SPEECH_SAMPLE_RATE;
// Whisper reads 30 s windows; committing well before that keeps each pass fast.
const MAX_SEGMENT_SAMPLES = 18 * SPEECH_SAMPLE_RATE;
const FORCED_CUT_SEARCH_SAMPLES = 5 * SPEECH_SAMPLE_RATE;
const TAIL_GUARD_FRAMES = 15; // a pause must end 300 ms before the newest audio

/**
 * Buffers 16 kHz audio not yet committed to text, and finds where a finished phrase ends.
 * Speech is judged by frame energy against the buffer's own noise floor.
 */
export class SpeechSegmenter {
  private samples = new Float32Array(SPEECH_SAMPLE_RATE * 4);
  private length = 0;
  private frameEnergy: number[] = [];

  get durationSamples(): number {
    return this.length;
  }

  append(chunk: Float32Array): void {
    if (this.length + chunk.length > this.samples.length) {
      const grown = new Float32Array(Math.max(this.samples.length * 2, this.length + chunk.length));
      grown.set(this.samples.subarray(0, this.length));
      this.samples = grown;
    }
    this.samples.set(chunk, this.length);
    this.length += chunk.length;
    for (let frame = this.frameEnergy.length; (frame + 1) * FRAME <= this.length; frame += 1) {
      let sum = 0;
      for (let index = frame * FRAME; index < (frame + 1) * FRAME; index += 1) {
        const value = this.samples[index] ?? 0;
        sum += value * value;
      }
      this.frameEnergy.push(Math.sqrt(sum / FRAME));
    }
  }

  /** A copy of everything buffered, for a preview pass. */
  snapshot(): Float32Array {
    return this.samples.slice(0, this.length);
  }

  /** Removes and returns the first `count` samples. */
  take(count: number): Float32Array {
    const taken = this.samples.slice(0, count);
    this.samples.copyWithin(0, count, this.length);
    this.length -= count;
    this.frameEnergy = this.frameEnergy.slice(Math.floor(count / FRAME));
    return taken;
  }

  clear(): void {
    this.length = 0;
    this.frameEnergy = [];
  }

  private speechThreshold(): number {
    if (this.frameEnergy.length === 0) return Infinity;
    const sorted = this.frameEnergy.toSorted((a, b) => a - b);
    const noiseFloor = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
    return Math.max(0.01, noiseFloor * 3);
  }

  speechFrames(endSamples = this.length): number {
    const threshold = this.speechThreshold();
    const frames = Math.floor(endSamples / FRAME);
    let count = 0;
    for (let frame = 0; frame < frames; frame += 1) {
      if ((this.frameEnergy[frame] ?? 0) > threshold) count += 1;
    }
    return count;
  }

  hasSpeech(endSamples = this.length): boolean {
    return this.speechFrames(endSamples) >= MIN_SPEECH_FRAMES;
  }

  /**
   * Where to cut a finished phrase off the front of the buffer: the middle of the latest pause
   * that follows speech, or the quietest frame near the size limit. Null keeps listening.
   */
  findCommitPoint(): number | null {
    if (this.length < MIN_COMMIT_SAMPLES) return null;
    const threshold = this.speechThreshold();
    // A backlog (audio buffered while the model loaded) drains in pieces Whisper can read whole.
    const lastFrame = Math.min(
      this.frameEnergy.length - TAIL_GUARD_FRAMES,
      Math.floor(MAX_SEGMENT_SAMPLES / FRAME),
    );
    let silentRun = 0;
    for (let frame = lastFrame - 1; frame >= 0; frame -= 1) {
      if ((this.frameEnergy[frame] ?? 0) <= threshold) {
        silentRun += 1;
        continue;
      }
      if (silentRun >= PAUSE_FRAMES) {
        const cut = (frame + 1 + Math.floor(silentRun / 2)) * FRAME;
        if (cut >= MIN_COMMIT_SAMPLES && this.hasSpeech(cut)) return cut;
      }
      silentRun = 0;
    }
    if (this.length < MAX_SEGMENT_SAMPLES) return null;
    const searchEnd = Math.floor(MAX_SEGMENT_SAMPLES / FRAME);
    const searchStart = Math.floor((MAX_SEGMENT_SAMPLES - FORCED_CUT_SEARCH_SAMPLES) / FRAME);
    let quietest = searchEnd - 1;
    for (let frame = searchStart; frame < searchEnd; frame += 1) {
      if ((this.frameEnergy[frame] ?? Infinity) < (this.frameEnergy[quietest] ?? Infinity)) {
        quietest = frame;
      }
    }
    return (quietest + 1) * FRAME;
  }
}
