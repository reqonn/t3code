import {
  isSpeechModelReady,
  subscribeToSpeechModel,
  transcribeAudio,
  warmUpSpeechModel,
} from "./dictationTranscriber";
import { normalizeDictatedText } from "./dictatedText";
import { SPEECH_SAMPLE_RATE, startMicCapture, type MicCapture } from "./micCapture";
import { SpeechSegmenter } from "./speechSegmenter";

export type DictationPhase = "idle" | "starting" | "listening" | "finishing";

export type DictationStatus = {
  readonly phase: DictationPhase;
  /** Load progress until the model is usable (0 while loading from cache); null once ready. */
  readonly modelPercent: number | null;
};

export type LiveDictationCallbacks = {
  readonly onStatus: (status: DictationStatus) => void;
  /** Words heard since the last committed phrase; "" clears the preview. */
  readonly onPreview: (text: string) => void;
  /** A finished phrase, ready to insert. */
  readonly onCommit: (text: string) => void;
  readonly onError: (message: string) => void;
};

const RECORDING_LIMIT_MS = 10 * 60_000;
// Like VS Code, a long silence ends dictation and keeps what was said.
const SILENCE_TIMEOUT_MS = 15_000;
const PREVIEW_INTERVAL_SAMPLES = SPEECH_SAMPLE_RATE / 2;
const MIN_PREVIEW_SAMPLES = Math.round(SPEECH_SAMPLE_RATE * 0.6);
// Whisper's stock output for near-silence; dropped unless a real phrase was spoken.
const SILENCE_HALLUCINATIONS = new Set(["you", "thank you", "thanks for watching", "bye"]);

function isHallucination(text: string, speechFrames: number): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z ]/g, "")
    .trim();
  return speechFrames < 50 && SILENCE_HALLUCINATIONS.has(normalized);
}

/** One dictation session: microphone in, previews and committed phrases out. */
export class LiveDictation {
  private readonly callbacks: LiveDictationCallbacks;
  private readonly segmenter = new SpeechSegmenter();
  private phase: DictationPhase = "idle";
  private modelPercent: number | null = null;
  private mic: MicCapture | null = null;
  private inference: Promise<void> | null = null;
  private samplesAtLastPreview = 0;
  private limitTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setInterval> | null = null;
  private lastSpeechAt = 0;
  private unsubscribeModel: (() => void) | null = null;
  private ended = false;

  constructor(callbacks: LiveDictationCallbacks) {
    this.callbacks = callbacks;
  }

  get currentPhase(): DictationPhase {
    return this.phase;
  }

  async start(): Promise<void> {
    if (this.phase !== "idle" || this.ended) return;
    this.setStatus("starting");
    this.unsubscribeModel = subscribeToSpeechModel((event) => {
      if (event.type === "progress") {
        this.modelPercent = event.percent;
        this.setStatus(this.phase);
      } else if (event.type === "ready") {
        this.modelPercent = null;
        this.setStatus(this.phase);
        this.pump();
      } else {
        this.fail(`The speech model couldn't load: ${event.message}`);
      }
    });
    if (!isSpeechModelReady()) warmUpSpeechModel();
    try {
      const mic = await startMicCapture((samples) => this.onAudio(samples));
      if (this.ended) {
        mic.stop();
        return;
      }
      this.mic = mic;
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "Could not start the microphone.");
      return;
    }
    this.limitTimer = setTimeout(() => void this.stop(), RECORDING_LIMIT_MS);
    this.lastSpeechAt = performance.now();
    this.silenceTimer = setInterval(() => {
      if (performance.now() - this.lastSpeechAt >= SILENCE_TIMEOUT_MS) void this.stop();
    }, 1000);
    this.setStatus("listening");
  }

  /** Stops listening and inserts what is still pending. */
  async stop(): Promise<void> {
    if (this.phase === "starting") {
      this.cancel();
      return;
    }
    if (this.phase !== "listening") return;
    this.releaseMicrophone();
    this.setStatus("finishing");
    try {
      await this.inference;
      if (this.ended) return;
      if (this.segmenter.hasSpeech()) {
        if (!isSpeechModelReady()) await this.waitForModel();
        if (this.ended) return;
        await this.commit(this.segmenter.durationSamples);
      }
    } catch (error) {
      this.reportFailure(error);
    }
    this.finish();
  }

  /** Stops without inserting pending speech. Phrases already committed stay. */
  cancel(): void {
    this.finish();
  }

  private onAudio(samples: Float32Array) {
    if (this.phase !== "listening" && this.phase !== "starting") return;
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    if (Math.sqrt(sum / samples.length) > this.segmenter.speechThreshold()) {
      this.lastSpeechAt = performance.now();
    }
    this.segmenter.append(samples);
    this.pump();
  }

  /** Runs at most one model pass at a time, preferring to commit a finished phrase. */
  private pump() {
    if (this.inference || this.phase !== "listening" || !isSpeechModelReady()) return;
    const cut = this.segmenter.findCommitPoint();
    let work: Promise<void> | null = null;
    if (cut !== null) {
      work = this.commit(cut);
    } else if (
      this.segmenter.durationSamples >= MIN_PREVIEW_SAMPLES &&
      this.segmenter.durationSamples - this.samplesAtLastPreview >= PREVIEW_INTERVAL_SAMPLES &&
      this.segmenter.hasSpeech()
    ) {
      work = this.preview();
    }
    if (!work) return;
    const tracked = work
      .catch((error: unknown) => this.reportFailure(error, { endSession: true }))
      .finally(() => {
        if (this.inference === tracked) this.inference = null;
        this.pump();
      });
    this.inference = tracked;
  }

  private async preview() {
    this.samplesAtLastPreview = this.segmenter.durationSamples;
    const text = normalizeDictatedText(await transcribeAudio(this.segmenter.snapshot()));
    if (this.ended || this.phase !== "listening") return;
    this.callbacks.onPreview(isHallucination(text, this.segmenter.speechFrames()) ? "" : text);
  }

  private async commit(cut: number) {
    const speechFrames = this.segmenter.speechFrames(cut);
    const audio = this.segmenter.take(cut);
    this.samplesAtLastPreview = 0;
    const text = normalizeDictatedText(await transcribeAudio(audio));
    if (this.ended) return;
    this.callbacks.onPreview("");
    if (text.length > 0 && !isHallucination(text, speechFrames)) this.callbacks.onCommit(text);
  }

  private waitForModel(): Promise<void> {
    return new Promise((resolve, reject) => {
      const unsubscribe = subscribeToSpeechModel((event) => {
        if (event.type === "progress") return;
        unsubscribe();
        if (event.type === "ready") resolve();
        else reject(new Error(event.message));
      });
      if (isSpeechModelReady()) {
        unsubscribe();
        resolve();
      }
    });
  }

  private reportFailure(error: unknown, options?: { endSession?: boolean }) {
    if (this.ended) return;
    const message =
      error instanceof Error && error.message ? error.message : "Transcription failed.";
    if (options?.endSession) this.fail(`Dictation stopped: ${message}`);
    else this.callbacks.onError(`Dictation stopped: ${message}`);
  }

  private fail(message: string) {
    if (this.ended) return;
    this.callbacks.onError(message);
    this.finish();
  }

  private releaseMicrophone() {
    this.mic?.stop();
    this.mic = null;
    if (this.limitTimer) clearTimeout(this.limitTimer);
    this.limitTimer = null;
    if (this.silenceTimer) clearInterval(this.silenceTimer);
    this.silenceTimer = null;
  }

  private finish() {
    if (this.ended) return;
    this.ended = true;
    this.releaseMicrophone();
    this.unsubscribeModel?.();
    this.unsubscribeModel = null;
    this.segmenter.clear();
    this.callbacks.onPreview("");
    this.modelPercent = null;
    this.setStatus("idle");
  }

  private setStatus(phase: DictationPhase) {
    this.phase = phase;
    const modelPercent = phase === "idle" || isSpeechModelReady() ? null : (this.modelPercent ?? 0);
    this.callbacks.onStatus({ phase, modelPercent });
  }
}
