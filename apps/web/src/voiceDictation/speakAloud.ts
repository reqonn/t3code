import type { KokoroWorkerRequest, KokoroWorkerResponse } from "./kokoroProtocol";

// Unloaded after a while unused to give its memory back; long enough to outlast a typical reply.
const IDLE_WORKER_TIMEOUT_MS = 10 * 60_000;
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

function scheduleIdleShutdown() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (pending.size === 0) stopWorker(new Error("The voice was unloaded."));
  }, IDLE_WORKER_TIMEOUT_MS);
}

function render(text: string): Promise<AudioBuffer> {
  const id = nextId++;
  return new Promise<AudioBuffer>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const request: KokoroWorkerRequest = { type: "speak", id, text };
    ensureWorker().postMessage(request, { transfer: [] });
  }).finally(scheduleIdleShutdown);
}

/** Loads the voice ahead of time, so the reply is read without waiting for it. */
export function warmUpVoice(): void {
  const request: KokoroWorkerRequest = { type: "load" };
  ensureWorker().postMessage(request, { transfer: [] });
  scheduleIdleShutdown();
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
  // Each sentence plays while the next one is being made, so speech starts sooner.
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((part) => part.trim()) ?? [text];
  const spoken = queue.then(async () => {
    const rendered = sentences.filter(Boolean).map(render);
    // Sentences after a failed one are dropped; their errors are not worth reporting twice.
    for (const audio of rendered) audio.catch(() => undefined);
    for (const audio of rendered) await play(await audio);
  });
  queue = spoken.catch(() => undefined);
  return spoken;
}
