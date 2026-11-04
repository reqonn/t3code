import { useEffect, useRef, useState } from "react";

import {
  decodeRecording,
  isSpeechModelReady,
  subscribeToSpeechModelProgress,
  transcribeAudio,
  warmUpSpeechModel,
} from "./dictationTranscriber";
import { normalizeDictatedText } from "./dictatedText";

const RECORDING_LIMIT_MS = 5 * 60_000;

export type DictationPhase = "idle" | "starting" | "recording" | "transcribing";

type RecordingSession = {
  readonly stream: MediaStream;
  readonly recorder: MediaRecorder;
  readonly chunks: Blob[];
  readonly limitTimer: ReturnType<typeof setTimeout>;
};

export function isDictationSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    navigator.mediaDevices?.getUserMedia !== undefined &&
    typeof MediaRecorder !== "undefined" &&
    typeof Worker !== "undefined"
  );
}

function stopTracks(stream: MediaStream) {
  for (const track of stream.getTracks()) track.stop();
}

function microphoneErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "Microphone access was blocked. Allow it in your browser or system settings.";
    }
    if (error.name === "NotFoundError") return "No microphone was found.";
  }
  return "Could not start the microphone.";
}

export function useVoiceDictation(input: {
  readonly onTranscript: (text: string) => void;
  readonly onError: (message: string) => void;
}) {
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [modelProgress, setModelProgress] = useState<number | null>(null);
  const sessionRef = useRef<RecordingSession | null>(null);
  const operationRef = useRef(0);
  const latestInput = useRef(input);
  // oxlint-disable-next-line react/refs -- transcription finishes asynchronously and must reach the composer's current handlers
  latestInput.current = input;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the microphone and listens to model download progress while mounted
  useEffect(() => {
    const unsubscribe = subscribeToSpeechModelProgress((fraction) => {
      setModelProgress(fraction >= 1 ? null : fraction);
    });
    return () => {
      unsubscribe();
      operationRef.current += 1;
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session) {
        clearTimeout(session.limitTimer);
        if (session.recorder.state !== "inactive") session.recorder.stop();
        stopTracks(session.stream);
      }
    };
  }, []);

  const stop = async () => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    clearTimeout(session.limitTimer);
    const operation = operationRef.current;
    setPhase("transcribing");
    try {
      if (session.recorder.state !== "inactive") {
        const stopped = new Promise((resolve) =>
          session.recorder.addEventListener("stop", resolve, { once: true }),
        );
        session.recorder.stop();
        await stopped;
      }
      stopTracks(session.stream);
      const recording = new Blob(session.chunks, { type: session.recorder.mimeType });
      if (recording.size === 0) throw new Error("No audio was recorded.");
      const text = normalizeDictatedText(await transcribeAudio(await decodeRecording(recording)));
      if (operation !== operationRef.current) return;
      if (text.length === 0) {
        latestInput.current.onError("No speech was detected.");
        return;
      }
      latestInput.current.onTranscript(text);
    } catch (error) {
      if (operation !== operationRef.current) return;
      latestInput.current.onError(
        error instanceof Error && error.message
          ? `Could not transcribe the recording: ${error.message}`
          : "Could not transcribe the recording.",
      );
    } finally {
      stopTracks(session.stream);
      if (operation === operationRef.current) setPhase("idle");
    }
  };

  const start = async () => {
    if (phase !== "idle") return;
    if (!isDictationSupported()) {
      latestInput.current.onError("Voice dictation isn't supported here.");
      return;
    }
    const operation = ++operationRef.current;
    setPhase("starting");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (error) {
      if (operation === operationRef.current) {
        setPhase("idle");
        latestInput.current.onError(microphoneErrorMessage(error));
      }
      return;
    }
    if (operation !== operationRef.current) {
      stopTracks(stream);
      return;
    }
    if (!isSpeechModelReady()) warmUpSpeechModel();
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    recorder.start();
    sessionRef.current = {
      stream,
      recorder,
      chunks,
      limitTimer: setTimeout(() => void stop(), RECORDING_LIMIT_MS),
    };
    setPhase("recording");
  };

  const cancel = () => {
    if (phase === "idle") return;
    operationRef.current += 1;
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) {
      clearTimeout(session.limitTimer);
      if (session.recorder.state !== "inactive") session.recorder.stop();
      stopTracks(session.stream);
    }
    setPhase("idle");
  };
  const cancelRef = useRef(cancel);
  // oxlint-disable-next-line react/refs -- the Escape listener must cancel with the current session state
  cancelRef.current = cancel;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Escape cancels a recording wherever focus is, usually the editor
  useEffect(() => {
    if (phase !== "recording") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      cancelRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [phase]);

  const toggle = () => {
    if (phase === "idle") void start();
    else if (phase === "recording") void stop();
  };

  return { phase, modelProgress, toggle, cancel };
}
