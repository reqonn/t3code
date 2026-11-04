import type { DictationWorkerRequest, DictationWorkerResponse } from "./whisperProtocol";

const SAMPLE_RATE = 16_000;
// The model holds a few hundred MB once loaded; reloading from the browser cache takes seconds.
const IDLE_WORKER_TIMEOUT_MS = 5 * 60_000;

type PendingTranscription = {
  readonly resolve: (text: string) => void;
  readonly reject: (error: Error) => void;
};

let worker: Worker | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let nextRequestId = 1;
let modelReady = false;
const pending = new Map<number, PendingTranscription>();
const progressListeners = new Set<(fraction: number) => void>();

function resetWorker(error: Error) {
  worker?.terminate();
  worker = null;
  modelReady = false;
  for (const request of pending.values()) request.reject(error);
  pending.clear();
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
      case "progress":
        for (const listener of progressListeners) listener(message.fraction);
        return;
      case "ready":
        modelReady = true;
        return;
      case "result": {
        const request = pending.get(message.id);
        pending.delete(message.id);
        request?.resolve(message.text);
        if (pending.size === 0) scheduleIdleShutdown();
        return;
      }
      case "error": {
        const error = new Error(message.message);
        if (message.id === null) {
          for (const request of pending.values()) request.reject(error);
          pending.clear();
          return;
        }
        const request = pending.get(message.id);
        pending.delete(message.id);
        request?.reject(error);
        if (pending.size === 0) scheduleIdleShutdown();
      }
    }
  });
  created.addEventListener("error", (event) => {
    resetWorker(new Error(event.message || "The speech model stopped unexpectedly."));
  });
  worker = created;
  return created;
}

function post(request: DictationWorkerRequest, transfer: Transferable[] = []) {
  ensureWorker().postMessage(request, transfer);
}

export function isSpeechModelReady(): boolean {
  return modelReady;
}

/** Starts the model download while the user is still speaking. */
export function warmUpSpeechModel(): void {
  post({ type: "load" });
  scheduleIdleShutdown();
}

export function subscribeToSpeechModelProgress(listener: (fraction: number) => void): () => void {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}

export async function decodeRecording(recording: Blob): Promise<Float32Array> {
  // An AudioContext at Whisper's rate makes decodeAudioData resample for us.
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  try {
    const buffer = await context.decodeAudioData(await recording.arrayBuffer());
    if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
    const mono = new Float32Array(buffer.length);
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let index = 0; index < data.length; index += 1) {
        mono[index] = (mono[index] ?? 0) + (data[index] ?? 0) / buffer.numberOfChannels;
      }
    }
    return mono;
  } finally {
    void context.close();
  }
}

export function transcribeAudio(audio: Float32Array): Promise<string> {
  const id = nextRequestId++;
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    post({ type: "transcribe", id, audio }, [audio.buffer]);
  });
}
