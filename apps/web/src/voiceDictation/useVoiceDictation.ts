import { useEffect, useRef, useState } from "react";

import { LiveDictation, type DictationStatus } from "./liveDictation";
import { playVoiceCue } from "./voiceCues";

export type { DictationPhase, DictationStatus } from "./liveDictation";

const IDLE_STATUS: DictationStatus = { phase: "idle", modelPercent: null };
// Holding the shortcut at least this long makes releasing it stop dictation (push to talk).
const HOLD_TO_TALK_MS = 400;
const START_CUE_MUTE_MS = 250;

export type DictationToggleOptions = {
  /** Push to talk: releasing this key after a hold stops dictation. */
  readonly holdKeyCode?: string;
  /**
   * Hands-free (the global F7 key): beeps instead of needing the screen, and calls this once
   * dictation ends with text inserted, so the caller can send it. Nothing heard: a low buzz.
   */
  readonly onHandsFreeDone?: () => void;
};

export function isDictationSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    navigator.mediaDevices?.getUserMedia !== undefined &&
    typeof AudioWorkletNode !== "undefined" &&
    typeof Worker !== "undefined"
  );
}

export function useVoiceDictation(input: {
  readonly onPreview: (text: string) => void;
  readonly onCommit: (text: string) => void;
  readonly onError: (message: string) => void;
}) {
  const [status, setStatus] = useState<DictationStatus>(IDLE_STATUS);
  const sessionRef = useRef<LiveDictation | null>(null);
  const heldKeyRef = useRef<{ readonly code: string; readonly since: number } | null>(null);
  const latestInput = useRef(input);
  // oxlint-disable-next-line react/refs -- phrases arrive asynchronously and must reach the composer's current handlers
  latestInput.current = input;

  const start = (options?: DictationToggleOptions) => {
    if (sessionRef.current) return;
    const onHandsFreeDone = options?.onHandsFreeDone;
    if (!isDictationSupported()) {
      if (onHandsFreeDone) playVoiceCue("nothing-heard");
      latestInput.current.onError("Voice dictation isn't supported here.");
      return;
    }
    let inserted = false;
    let phase: DictationStatus["phase"] = "idle";
    const session = new LiveDictation({
      onStatus: (next) => {
        if (sessionRef.current !== session) return;
        if (onHandsFreeDone && next.phase !== phase) {
          if (next.phase === "listening") {
            // The mic would hear the beep, and Whisper would try to read it as words.
            session.ignoreAudioFor(START_CUE_MUTE_MS);
            playVoiceCue("start");
          } else if (next.phase === "finishing") playVoiceCue("stop");
          else if (next.phase === "idle") {
            if (inserted) onHandsFreeDone();
            else playVoiceCue("nothing-heard");
          }
        }
        phase = next.phase;
        setStatus(next);
        if (next.phase === "idle") {
          sessionRef.current = null;
          heldKeyRef.current = null;
        }
      },
      onPreview: (text) => {
        if (sessionRef.current === session) latestInput.current.onPreview(text);
      },
      onCommit: (text) => {
        if (sessionRef.current !== session) return;
        inserted = true;
        latestInput.current.onCommit(text);
      },
      onError: (message) => latestInput.current.onError(message),
    });
    sessionRef.current = session;
    heldKeyRef.current = options?.holdKeyCode
      ? { code: options.holdKeyCode, since: performance.now() }
      : null;
    void session.start();
  };

  const stop = () => void sessionRef.current?.stop();
  const cancel = () => sessionRef.current?.cancel();

  /** Starts, or stops a session that is listening; clicking while it starts or finishes cancels. */
  const toggle = (options?: DictationToggleOptions) => {
    const session = sessionRef.current;
    if (!session) start(options);
    else if (session.currentPhase === "listening") void session.stop();
    else session.cancel();
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the microphone when the composer unmounts
  useEffect(() => () => sessionRef.current?.cancel(), []);

  const active = status.phase !== "idle";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Escape and the released shortcut stop dictation wherever focus is, usually the editor
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      void sessionRef.current?.stop();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const held = heldKeyRef.current;
      if (!held || event.code !== held.code) return;
      heldKeyRef.current = null;
      if (performance.now() - held.since >= HOLD_TO_TALK_MS) void sessionRef.current?.stop();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [active]);

  return { status, toggle, stop, cancel };
}
