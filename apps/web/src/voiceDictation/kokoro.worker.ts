import { env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import ortWasmLoaderUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";

import type { KokoroWorkerRequest, KokoroWorkerResponse } from "./kokoroProtocol";

// Same runtime setup as whisper.worker.ts: the desktop CSP blocks the CDN and blob: imports.
env.allowLocalModels = false;
env.useWasmCache = false;
const onnxWasm = env.backends.onnx.wasm;
if (onnxWasm) onnxWasm.wasmPaths = { mjs: ortWasmLoaderUrl, wasm: ortWasmUrl };

// About 90 MB, downloaded once. The CPU keeps the GPU free for whatever else is running.
const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
// Heart at 1.2x. Other voices: af_bella, af_sky, af_nova, am_michael, ... (VOICES in kokoro-js).
const VOICE = "af_heart";
const SPEED = 1.2;

let ttsPromise: Promise<KokoroTTS> | null = null;
// The model runs one request at a time.
let busy: Promise<unknown> = Promise.resolve();

function loadTts(): Promise<KokoroTTS> {
  ttsPromise ??= KokoroTTS.from_pretrained(MODEL_ID, { dtype: "q8", device: "wasm" });
  ttsPromise.catch(() => {
    ttsPromise = null;
  });
  return ttsPromise;
}

function reply(message: KokoroWorkerResponse, transfer: Transferable[] = []) {
  self.postMessage(message, { transfer });
}

self.addEventListener("message", (event: MessageEvent<KokoroWorkerRequest>) => {
  const request = event.data;
  if (request.type === "load") {
    void loadTts().catch(() => undefined);
    return;
  }
  const { id, text } = request;
  const generated = busy
    .then(loadTts)
    .then((tts) => tts.generate(text, { voice: VOICE, speed: SPEED }));
  busy = generated.catch(() => undefined);
  generated
    .then((audio) => {
      const samples = audio.data;
      reply({ type: "audio", id, samples, sampleRate: audio.sampling_rate }, [samples.buffer]);
    })
    .catch((error: unknown) => {
      reply({ type: "error", id, message: error instanceof Error ? error.message : String(error) });
    });
});
