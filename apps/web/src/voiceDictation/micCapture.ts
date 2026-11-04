import workletUrl from "./pcmCapture.worklet.js?url";

export const SPEECH_SAMPLE_RATE = 16_000;
const MICROPHONE_START_TIMEOUT_MS = 10_000;

export type MicCapture = {
  readonly stop: () => void;
};

class MicrophoneError extends Error {}

function microphoneErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "Microphone access was blocked. Allow it in your browser or system settings.";
    }
    if (error.name === "NotFoundError") return "No microphone was found.";
    if (error.name === "NotReadableError") {
      return "The microphone is in use by another app or could not be opened.";
    }
  }
  return "Could not start the microphone.";
}

/** Averages each output sample over its input window, which also low-passes before decimating. */
export function createResampler(inputRate: number, outputRate = SPEECH_SAMPLE_RATE) {
  const step = inputRate / outputRate;
  let carry = new Float32Array(0);
  let position = 0;
  return (input: Float32Array): Float32Array => {
    const samples = new Float32Array(carry.length + input.length);
    samples.set(carry);
    samples.set(input, carry.length);
    const count = Math.max(0, Math.floor((samples.length - position) / step));
    const output = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      const start = Math.floor(position + index * step);
      const end = Math.min(
        samples.length,
        Math.max(start + 1, Math.floor(position + (index + 1) * step)),
      );
      let sum = 0;
      for (let sample = start; sample < end; sample += 1) sum += samples[sample] ?? 0;
      output[index] = sum / (end - start);
    }
    const consumed = position + count * step;
    const keepFrom = Math.floor(consumed);
    carry = samples.slice(keepFrom);
    position = consumed - keepFrom;
    return output;
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new MicrophoneError(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Streams 16 kHz mono microphone audio until stopped. */
export async function startMicCapture(
  onAudio: (samples: Float32Array) => void,
): Promise<MicCapture> {
  const streamRequest = navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  let stream: MediaStream;
  try {
    stream = await withTimeout(
      streamRequest,
      MICROPHONE_START_TIMEOUT_MS,
      "The microphone didn't respond. Check your input device and try again.",
    );
  } catch (error) {
    // A request that resolves after the timeout must still release the device.
    void streamRequest.then(
      (late) => late.getTracks().forEach((track) => track.stop()),
      () => {},
    );
    if (error instanceof MicrophoneError) throw error;
    throw new MicrophoneError(microphoneErrorMessage(error));
  }

  const context = new AudioContext();
  const stop = () => {
    for (const track of stream.getTracks()) track.stop();
    void context.close().catch(() => {});
  };
  try {
    await withTimeout(
      context.audioWorklet.addModule(workletUrl),
      MICROPHONE_START_TIMEOUT_MS,
      "Audio processing didn't start. Try again.",
    );
    const resample = createResampler(context.sampleRate);
    const node = new AudioWorkletNode(context, "pcm-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: "explicit",
    });
    node.port.addEventListener("message", (event: MessageEvent<Float32Array>) => {
      const samples = resample(event.data);
      if (samples.length > 0) onAudio(samples);
    });
    node.port.start();
    context.createMediaStreamSource(stream).connect(node);
    if (context.state === "suspended") await context.resume();
  } catch (error) {
    stop();
    throw error instanceof MicrophoneError
      ? error
      : new MicrophoneError("Could not start audio capture.");
  }
  return { stop };
}
