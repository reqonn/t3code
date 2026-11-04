import {
  env,
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
  type ProgressInfo,
} from "@huggingface/transformers";
import ortWasmLoaderUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";

import type { DictationWorkerRequest, DictationWorkerResponse } from "./whisperProtocol";

const MODEL_ID = "onnx-community/whisper-base";

env.allowLocalModels = false;
// transformers.js loads the ONNX runtime from a CDN, then imports it as a blob: URL. The desktop
// CSP allows neither, so serve the runtime from our own origin and import it directly.
env.useWasmCache = false;
const onnxWasm = env.backends.onnx.wasm;
if (onnxWasm) onnxWasm.wasmPaths = { mjs: ortWasmLoaderUrl, wasm: ortWasmUrl };

let transcriberPromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

function reply(message: DictationWorkerResponse) {
  self.postMessage(message, { transfer: [] });
}

async function hasWebGpu(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

function loadTranscriber(): Promise<AutomaticSpeechRecognitionPipeline> {
  if (transcriberPromise) return transcriberPromise;
  const fileProgress = new Map<string, { loaded: number; total: number }>();
  const onProgress = (info: ProgressInfo) => {
    if (info.status !== "progress") return;
    fileProgress.set(info.file, { loaded: info.loaded, total: info.total });
    let loaded = 0;
    let total = 0;
    for (const file of fileProgress.values()) {
      loaded += file.loaded;
      total += file.total;
    }
    if (total > 0) reply({ type: "progress", fraction: loaded / total });
  };
  transcriberPromise = (async () => {
    const webGpu = await hasWebGpu();
    // Quantized decoders keep the one-time download small; WebGPU needs an fp32 encoder for accuracy.
    const transcriber = await pipeline("automatic-speech-recognition", MODEL_ID, {
      device: webGpu ? "webgpu" : "wasm",
      dtype: webGpu ? { encoder_model: "fp32", decoder_model_merged: "q4" } : "q8",
      progress_callback: onProgress,
    });
    reply({ type: "ready" });
    return transcriber;
  })();
  transcriberPromise.catch(() => {
    transcriberPromise = null;
  });
  return transcriberPromise;
}

async function handle(request: DictationWorkerRequest) {
  if (request.type === "load") {
    await loadTranscriber();
    return;
  }
  const transcriber = await loadTranscriber();
  // transformers.js assumes English unless told otherwise; people usually dictate in their UI language.
  // Callers send under 30 s, Whisper's window, so no chunking. The token cap bounds a
  // hallucination loop; 20 s of fast speech is ~100 tokens.
  const transcribe = (language: string) =>
    transcriber(request.audio, { task: "transcribe", language, max_new_tokens: 224 });
  const uiLanguage = navigator.language.split("-")[0]?.toLowerCase() || "en";
  const output = await transcribe(uiLanguage).catch((error: unknown) => {
    if (
      uiLanguage !== "en" &&
      error instanceof Error &&
      error.message.includes("is not supported")
    ) {
      return transcribe("en");
    }
    throw error;
  });
  const text = (Array.isArray(output) ? output : [output]).map((chunk) => chunk.text).join(" ");
  reply({ type: "result", id: request.id, text: text.trim() });
}

self.addEventListener("message", (event: MessageEvent<DictationWorkerRequest>) => {
  const request = event.data;
  handle(request).catch((error: unknown) => {
    reply({
      type: "error",
      id: request.type === "transcribe" ? request.id : null,
      message: error instanceof Error ? error.message : String(error),
    });
  });
});
