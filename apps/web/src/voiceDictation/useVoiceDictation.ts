import { useEffect, useRef, useState } from "react";

import { LiveDictation, type DictationStatus } from "./liveDictation";

export type { DictationPhase, DictationStatus } from "./liveDictation";

const IDLE_STATUS: DictationStatus = { phase: "idle", modelPercent: null };
// Holding the shortcut at least this long makes releasing it stop dictation (push to talk).
const HOLD_TO_TALK_MS = 400;

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

  const start = (holdKeyCode?: string) => {
    if (sessionRef.current) return;
    if (!isDictationSupported()) {
      latestInput.current.onError("Voice dictation isn't supported here.");
      return;
    }
    const session = new LiveDictation({
      onStatus: (next) => {
        if (sessionRef.current !== session) return;
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
        if (sessionRef.current === session) latestInput.current.onCommit(text);
      },
      onError: (message) => latestInput.current.onError(message),
    });
    sessionRef.current = session;
    heldKeyRef.current = holdKeyCode ? { code: holdKeyCode, since: performance.now() } : null;
    void session.start();
  };

  const stop = () => void sessionRef.current?.stop();
  const cancel = () => sessionRef.current?.cancel();

  /** Starts, or stops a session that is listening; clicking while it starts or finishes cancels. */
  const toggle = (options?: { readonly holdKeyCode?: string }) => {
    const session = sessionRef.current;
    if (!session) start(options?.holdKeyCode);
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
