import { MicIcon, SquareIcon } from "lucide-react";
import { useImperativeHandle, type Ref } from "react";

import { useVoiceDictation } from "../../voiceDictation/useVoiceDictation";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface ComposerDictationButtonHandle {
  toggle: (options?: { readonly holdKeyCode?: string }) => void;
}

export function ComposerDictationButton({
  ref,
  shortcutLabel,
  onPreview,
  onCommit,
  onError,
}: {
  readonly ref?: Ref<ComposerDictationButtonHandle>;
  readonly shortcutLabel: string | null;
  readonly onPreview: (text: string) => void;
  readonly onCommit: (text: string) => void;
  readonly onError: (message: string) => void;
}) {
  const { status, toggle } = useVoiceDictation({ onPreview, onCommit, onError });
  useImperativeHandle(ref, () => ({ toggle }), [toggle]);

  const shortcut = shortcutLabel ? ` (${shortcutLabel})` : "";
  const loading =
    status.modelPercent === null
      ? null
      : status.modelPercent > 0
        ? `Loading speech model ${status.modelPercent}%`
        : "Loading speech model…";
  const label =
    status.phase === "listening"
      ? (loading ?? "Listening…")
      : status.phase === "finishing"
        ? (loading ?? "Finishing…")
        : null;
  const tooltip =
    status.phase === "idle"
      ? `Dictate${shortcut}. Hold the shortcut to talk, or press it again to stop.`
      : status.phase === "listening"
        ? `Stop dictation${shortcut}. Esc also stops, and so do 15 seconds of silence.`
        : status.phase === "starting"
          ? "Starting the microphone. Click to cancel."
          : "Finishing the last words. Click to cancel them.";

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant={status.phase === "listening" ? "destructive" : "ghost"}
              size="icon-sm"
              aria-label={status.phase === "idle" ? "Dictate" : "Stop dictation"}
              aria-pressed={status.phase !== "idle"}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => toggle()}
            />
          }
        >
          {status.phase === "listening" ? (
            <SquareIcon className="size-3 fill-current" />
          ) : status.phase === "idle" ? (
            <MicIcon />
          ) : (
            <Spinner />
          )}
        </TooltipTrigger>
        <TooltipPopup>{tooltip}</TooltipPopup>
      </Tooltip>
      {label ? (
        <span aria-live="polite" className="truncate text-muted-foreground text-xs">
          {label}
        </span>
      ) : null}
    </div>
  );
}
