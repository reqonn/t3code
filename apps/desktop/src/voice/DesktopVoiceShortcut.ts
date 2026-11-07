import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Electron from "electron";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

// F7 from any app, even a full-screen game, starts or stops voice in the open chat without
// bringing T3 Code forward. Ctrl+F7 turns that on or off, and it stays that way after a restart.
// The keys are released when T3 Code quits, so F7 is an ordinary key again.
const TOGGLE_KEY = "F7";
const SWITCH_KEY = "CommandOrControl+F7";

// Menu actions the chat listens for; see apps/web/src/voiceDictation/useVoiceShortcut.ts.
const VOICE_TOGGLE_ACTION = "voice.toggle";
const VOICE_ENABLED_ACTION = "voice.enabled";
const VOICE_DISABLED_ACTION = "voice.disabled";

const { logInfo, logWarning } = makeComponentLogger("desktop-voice-shortcut");

export const register = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

  // Present while Ctrl+F7 has turned voice off.
  const offMarker = path.join(environment.stateDir, "voice-shortcut-off");
  let enabled = !(yield* fileSystem.exists(offMarker).pipe(Effect.orElseSucceed(() => false)));

  const send = (action: string) =>
    void runPromise(
      desktopWindow.dispatchMenuAction(action, { reveal: false }).pipe(Effect.ignoreCause),
    );

  const registerToggle = () => {
    if (Electron.globalShortcut.register(TOGGLE_KEY, () => send(VOICE_TOGGLE_ACTION))) return;
    void runPromise(logWarning("F7 is taken by another app; voice shortcut unavailable"));
  };

  const persist = (on: boolean) =>
    (on ? fileSystem.remove(offMarker) : fileSystem.writeFileString(offMarker, "")).pipe(
      Effect.catch((error) => logWarning("could not save the voice shortcut state", { error })),
    );

  const onSwitch = () => {
    enabled = !enabled;
    if (enabled) registerToggle();
    else Electron.globalShortcut.unregister(TOGGLE_KEY);
    send(enabled ? VOICE_ENABLED_ACTION : VOICE_DISABLED_ACTION);
    void runPromise(persist(enabled));
  };

  if (enabled) registerToggle();
  if (!Electron.globalShortcut.register(SWITCH_KEY, onSwitch)) {
    yield* logWarning("Ctrl+F7 is taken by another app; voice can't be switched off by key");
  }
  yield* logInfo("voice shortcut registered", { enabled });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      Electron.globalShortcut.unregister(TOGGLE_KEY);
      Electron.globalShortcut.unregister(SWITCH_KEY);
    }),
  );
}).pipe(Effect.withSpan("desktop.voiceShortcut.register"));
