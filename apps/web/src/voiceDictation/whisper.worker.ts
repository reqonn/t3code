import {
  env,
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
  type ProgressInfo,
} from "@huggingface/transformers";
import ortWasmLoaderUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";

import type { DictationWorkerRequest, DictationWorkerResponse } from "./whisperProtocol";
import { transcribeWithContext } from "./whisperPrompt";

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

type GpuAdapter = { readonly features: ReadonlySet<string> };

async function requestGpuAdapter(): Promise<GpuAdapter | null> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<GpuAdapter | null> } })
    .gpu;
  if (!gpu) return null;
  try {
    return await gpu.requestAdapter();
  } catch {
    return null;
  }
}

/**
 * Large v3 Turbo is far more accurate but needs half-precision GPU shaders to stay fast and its
 * download near 560 MB; anything less runs Base (about 200 MB on GPU, 80 MB on CPU).
 */
async function chooseModel() {
  const adapter = await requestGpuAdapter();
  if (adapter?.features.has("shader-f16")) {
    return {
      id: "onnx-community/whisper-large-v3-turbo",
      device: "webgpu",
      dtype: { encoder_model: "q4f16", decoder_model_merged: "q4f16" },
    } as const;
  }
  // WebGPU needs an fp32 encoder for Base's accuracy; quantized decoders keep the download small.
  return adapter
    ? ({
        id: "onnx-community/whisper-base",
        device: "webgpu",
        dtype: { encoder_model: "fp32", decoder_model_merged: "q4" },
      } as const)
    : ({ id: "onnx-community/whisper-base", device: "wasm", dtype: "q8" } as const);
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
    const model = await chooseModel();
    const transcriber = await pipeline("automatic-speech-recognition", model.id, {
      device: model.device,
      dtype: model.dtype,
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
  // People usually dictate in their UI language. Callers send under 30 s, Whisper's window.
  const transcribe = (language: string) =>
    transcribeWithContext(transcriber, request.audio, language, request.context);
  const uiLanguage = navigator.language.split("-")[0]?.toLowerCase() || "en";
  const text = await transcribe(uiLanguage).catch((error: unknown) => {
    if (
      uiLanguage !== "en" &&
      error instanceof Error &&
      error.message.includes("is not supported")
    ) {
      return transcribe("en");
    }
    throw error;
  });
  reply({ type: "result", id: request.id, text });
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
