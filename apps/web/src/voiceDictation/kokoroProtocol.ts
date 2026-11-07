export type KokoroWorkerRequest = { readonly id: number; readonly text: string };

export type KokoroWorkerResponse =
  | {
      readonly type: "audio";
      readonly id: number;
      readonly samples: Float32Array;
      readonly sampleRate: number;
    }
  | { readonly type: "error"; readonly id: number; readonly message: string };
