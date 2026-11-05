export type DictationWorkerRequest =
  | { readonly type: "load" }
  | {
      readonly type: "transcribe";
      readonly id: number;
      readonly audio: Float32Array;
      /** Text heard just before this audio, which helps Whisper read short phrases. */
      readonly context: string;
    };

export type DictationWorkerResponse =
  | { readonly type: "progress"; readonly fraction: number }
  | { readonly type: "ready" }
  | { readonly type: "result"; readonly id: number; readonly text: string }
  | { readonly type: "error"; readonly id: number | null; readonly message: string };
