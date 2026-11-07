import { useEffect, type RefObject } from "react";

import type { ChatComposerHandle } from "../components/chat/ChatComposer";
import { useStableCallback } from "../hooks/useStableCallback";
import { speakAloud, warmUpVoice } from "./speakAloud";
import { spokenSummary } from "./spokenSummary";
import { playVoiceCue } from "./voiceCues";

// Sent by the desktop app's global F7 and Ctrl+F7 (apps/desktop/src/voice/DesktopVoiceShortcut.ts).
const TOGGLE_ACTION = "voice.toggle";
const ENABLED_ACTION = "voice.enabled";
const DISABLED_ACTION = "voice.disabled";

type VoiceMessage = { readonly role: string; readonly text: string; readonly streaming: boolean };

type AwaitedReply = {
  /** User messages in the thread before the spoken one. */
  readonly userMessagesBefore: number;
  /** A run started after the spoken message arrived, so the next settled state is its end. */
  started: boolean;
};

// Kept outside React, so a reply is still read if the chat view remounts meanwhile.
const awaitedReplies = new Map<string, AwaitedReply>();

const countUserMessages = (messages: ReadonlyArray<VoiceMessage>) =>
  messages.filter((message) => message.role === "user").length;

/**
 * F7 from anywhere dictates into this chat and sends it when you stop; the reply's opening is
 * then read aloud. Only spoken messages get a spoken reply.
 */
export function useVoiceShortcut(input: {
  readonly enabled: boolean;
  readonly threadKey: string | null;
  readonly composerRef: RefObject<ChatComposerHandle | null>;
  readonly messages: ReadonlyArray<VoiceMessage> | null;
  readonly running: boolean;
}) {
  const { enabled, threadKey, composerRef, messages, running } = input;

  const sendSpokenMessage = useStableCallback(() => {
    if (threadKey === null) return;
    awaitedReplies.set(threadKey, {
      userMessagesBefore: countUserMessages(messages ?? []),
      started: false,
    });
    composerRef.current?.submit();
    warmUpVoice();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the desktop app's global voice shortcut
  useEffect(() => {
    if (!enabled) return;
    return window.desktopBridge?.onMenuAction((action) => {
      if (action === ENABLED_ACTION) playVoiceCue("enabled");
      else if (action === DISABLED_ACTION) playVoiceCue("disabled");
      else if (action === TOGGLE_ACTION) {
        composerRef.current?.toggleDictation({ onHandsFreeDone: sendSpokenMessage });
      }
    });
  }, [enabled, composerRef, sendSpokenMessage]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the reply aloud once the spoken message's run ends
  useEffect(() => {
    if (threadKey === null || messages === null) return;
    const awaited = awaitedReplies.get(threadKey);
    if (!awaited || countUserMessages(messages) <= awaited.userMessagesBefore) return;
    if (running) {
      awaited.started = true;
      return;
    }
    if (!awaited.started) return;
    const lastUser = messages.findLastIndex((message) => message.role === "user");
    const reply = messages
      .slice(lastUser + 1)
      .findLast((message) => message.role === "assistant" && !message.streaming);
    if (!reply) {
      // A run ended before the spoken message's own one (it was queued behind it).
      awaited.started = false;
      return;
    }
    awaitedReplies.delete(threadKey);
    const text = spokenSummary(reply.text);
    if (text) void speakAloud(text).catch(() => playVoiceCue("nothing-heard"));
  }, [threadKey, messages, running]);
}
