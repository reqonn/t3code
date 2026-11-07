import type { KokoroWorkerRequest, KokoroWorkerResponse } from "./kokoroProtocol";

// Like the speech-to-text model, the voice is unloaded when idle to give its memory back.
const IDLE_WORKER_TIMEOUT_MS = 60_000;
const VOLUME = 0.6;

let worker: Worker | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let nextId = 1;
let context: AudioContext | null = null;
const pending = new Map<
  number,
  { readonly resolve: (audio: AudioBuffer) => void; readonly reject: (error: Error) => void }
>();
// One summary at a time, in order.
let queue: Promise<void> = Promise.resolve();

function stopWorker(error: Error) {
  worker?.terminate();
  worker = null;
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}

function ensureWorker(): Worker {
  if (idleTimer) clearTimeout(idleTimer);
  if (worker) return worker;
  const created = new Worker(new URL("./kokoro.worker.ts", import.meta.url), { type: "module" });
  created.addEventListener("message", (event: MessageEvent<KokoroWorkerResponse>) => {
    const message = event.data;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.type === "error") {
      request.reject(new Error(message.message));
      return;
    }
    context ??= new AudioContext();
    const buffer = context.createBuffer(1, message.samples.length, message.sampleRate);
    buffer.copyToChannel(new Float32Array(message.samples), 0);
    request.resolve(buffer);
  });
  created.addEventListener("error", (event) => {
    stopWorker(new Error(event.message || "The voice stopped unexpectedly."));
  });
  worker = created;
  return created;
}

function render(text: string): Promise<AudioBuffer> {
  const id = nextId++;
  return new Promise<AudioBuffer>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const request: KokoroWorkerRequest = { id, text };
    ensureWorker().postMessage(request, { transfer: [] });
  }).finally(() => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (pending.size === 0) stopWorker(new Error("The voice was unloaded."));
    }, IDLE_WORKER_TIMEOUT_MS);
  });
}

async function play(buffer: AudioBuffer): Promise<void> {
  context ??= new AudioContext();
  await context.resume();
  const source = context.createBufferSource();
  const gain = context.createGain();
  gain.gain.value = VOLUME;
  source.buffer = buffer;
  source.connect(gain).connect(context.destination);
  await new Promise<void>((resolve) => {
    source.addEventListener("ended", () => resolve(), { once: true });
    source.start();
  });
}

/** Reads text aloud offline with Kokoro. The first use downloads the voice (about 90 MB). */
export function speakAloud(text: string): Promise<void> {
  const spoken = queue.then(() => render(text)).then(play);
  queue = spoken.catch(() => undefined);
  return spoken;
}
