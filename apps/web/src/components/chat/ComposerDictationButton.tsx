import { MicIcon, SquareIcon } from "lucide-react";
import { useImperativeHandle, type Ref } from "react";

import { useVoiceDictation } from "../../voiceDictation/useVoiceDictation";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface ComposerDictationButtonHandle {
  toggle: () => void;
  cancel: () => void;
}

export function ComposerDictationButton({
  ref,
  shortcutLabel,
  onTranscript,
  onError,
}: {
  readonly ref?: Ref<ComposerDictationButtonHandle>;
  readonly shortcutLabel: string | null;
  readonly onTranscript: (text: string) => void;
  readonly onError: (message: string) => void;
}) {
  const dictation = useVoiceDictation({ onTranscript, onError });
  useImperativeHandle(ref, () => ({ toggle: dictation.toggle, cancel: dictation.cancel }), [
    dictation.toggle,
    dictation.cancel,
  ]);

  const downloading =
    dictation.modelProgress !== null
      ? `Downloading speech model ${Math.round(dictation.modelProgress * 100)}%`
      : null;
  const label =
    dictation.phase === "recording"
      ? "Stop dictation"
      : dictation.phase === "transcribing"
        ? (downloading ?? "Transcribing…")
        : dictation.phase === "starting"
          ? "Starting microphone…"
          : "Dictate";
  const tooltip =
    dictation.phase === "recording"
      ? `${downloading ? `${downloading}. ` : ""}Click to stop and insert text. Esc cancels.`
      : label;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant={dictation.phase === "recording" ? "destructive" : "ghost"}
            size="icon-sm"
            aria-label={label}
            aria-pressed={dictation.phase === "recording"}
            disabled={dictation.phase === "starting" || dictation.phase === "transcribing"}
            onPointerDown={(event) => event.preventDefault()}
            onClick={dictation.toggle}
          />
        }
      >
        {dictation.phase === "recording" ? (
          <SquareIcon className="size-3 fill-current" />
        ) : dictation.phase === "idle" ? (
          <MicIcon />
        ) : (
          <Spinner />
        )}
      </TooltipTrigger>
      <TooltipPopup>
        {tooltip}
        {dictation.phase === "idle" && shortcutLabel ? ` (${shortcutLabel})` : null}
      </TooltipPopup>
    </Tooltip>
  );
}
