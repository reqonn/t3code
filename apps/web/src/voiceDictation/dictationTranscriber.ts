import { SPEECH_SAMPLE_RATE } from "./micCapture";
import type { DictationWorkerRequest, DictationWorkerResponse } from "./whisperProtocol";

// The loaded model holds GPU memory that games and other apps want back, but reloading it makes
// the next dictation slow to finish, so it stays loaded for a while between uses.
const IDLE_WORKER_TIMEOUT_MS = 10 * 60_000;

type PendingTranscription = {
  readonly resolve: (text: string) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

export type SpeechModelEvent =
  | { readonly type: "progress"; readonly percent: number }
  | { readonly type: "ready" }
  | { readonly type: "failed"; readonly message: string };

let worker: Worker | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let nextRequestId = 1;
let modelReady = false;
let lastPercent = -1;
const pending = new Map<number, PendingTranscription>();
const modelListeners = new Set<(event: SpeechModelEvent) => void>();

function emitModelEvent(event: SpeechModelEvent) {
  for (const listener of modelListeners) listener(event);
}

function settle(id: number, outcome: { text: string } | { error: Error }) {
  const request = pending.get(id);
  if (!request) return;
  pending.delete(id);
  clearTimeout(request.timer);
  if ("text" in outcome) request.resolve(outcome.text);
  else request.reject(outcome.error);
  if (pending.size === 0) scheduleIdleShutdown();
}

function resetWorker(error: Error) {
  worker?.terminate();
  worker = null;
  modelReady = false;
  lastPercent = -1;
  for (const id of pending.keys()) settle(id, { error });
}

function scheduleIdleShutdown() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (pending.size === 0) resetWorker(new Error("Speech model was unloaded."));
  }, IDLE_WORKER_TIMEOUT_MS);
}

function ensureWorker(): Worker {
  if (idleTimer) clearTimeout(idleTimer);
  if (worker) return worker;
  const created = new Worker(new URL("./whisper.worker.ts", import.meta.url), { type: "module" });
  created.addEventListener("message", (event: MessageEvent<DictationWorkerResponse>) => {
    const message = event.data;
    switch (message.type) {
      case "progress": {
        const percent = Math.min(99, Math.floor(message.fraction * 100));
        if (percent === lastPercent) return;
        lastPercent = percent;
        emitModelEvent({ type: "progress", percent });
        return;
      }
      case "ready":
        modelReady = true;
        emitModelEvent({ type: "ready" });
        return;
      case "result":
        settle(message.id, { text: message.text });
        return;
      case "error": {
        const error = new Error(message.message);
        if (message.id !== null) {
          settle(message.id, { error });
          return;
        }
        lastPercent = -1;
        for (const id of pending.keys()) settle(id, { error });
        emitModelEvent({ type: "failed", message: message.message });
      }
    }
  });
  created.addEventListener("error", (event) => {
    const message = event.message || "The speech model stopped unexpectedly.";
    resetWorker(new Error(message));
    emitModelEvent({ type: "failed", message });
  });
  worker = created;
  return created;
}

export function isSpeechModelReady(): boolean {
  return modelReady;
}

/** Starts loading (and on first use downloading) the model, usually while the user speaks. */
export function warmUpSpeechModel(): void {
  const message: DictationWorkerRequest = { type: "load" };
  ensureWorker().postMessage(message, { transfer: [] });
  scheduleIdleShutdown();
}

export function subscribeToSpeechModel(listener: (event: SpeechModelEvent) => void): () => void {
  modelListeners.add(listener);
  return () => modelListeners.delete(listener);
}

/**
 * Transcribes 16 kHz mono audio. A pass that outlives its budget restarts the worker, so a
 * wedged GPU or runtime surfaces as an error instead of an endless spinner.
 */
export function transcribeAudio(audio: Float32Array, context: string): Promise<string> {
  const id = nextRequestId++;
  const budgetMs = 30_000 + (audio.length / SPEECH_SAMPLE_RATE) * 3_000;
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      resetWorker(new Error("The speech model stopped responding, so it was restarted."));
    }, budgetMs);
    pending.set(id, { resolve, reject, timer });
    const message: DictationWorkerRequest = { type: "transcribe", id, audio, context };
    ensureWorker().postMessage(message, { transfer: [audio.buffer] });
  });
}
