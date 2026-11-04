// Whisper labels silence with bracketed tags such as "[BLANK_AUDIO]" rather than returning nothing.
const NON_SPEECH_ONLY = /^(?:\s*(?:\[[^\]]*\]|\([^)]*\)))+\s*$/;

export function normalizeDictatedText(text: string): string {
  const trimmed = text.trim();
  return NON_SPEECH_ONLY.test(trimmed) ? "" : trimmed;
}
