export type DictationWorkerRequest =
  | { readonly type: "load" }
  | { readonly type: "transcribe"; readonly id: number; readonly audio: Float32Array };

export type DictationWorkerResponse =
  | { readonly type: "progress"; readonly fraction: number }
  | { readonly type: "ready" }
  | { readonly type: "result"; readonly id: number; readonly text: string }
  | { readonly type: "error"; readonly id: number | null; readonly message: string };
