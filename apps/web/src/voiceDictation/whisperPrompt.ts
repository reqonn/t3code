import type { AutomaticSpeechRecognitionPipeline, Tensor } from "@huggingface/transformers";

// Whisper reads at most 224 prompt tokens; a sentence or two of context is what helps.
const MAX_PROMPT_TOKENS = 96;
// 20 s of fast speech is ~100 tokens; the cap also bounds a hallucination loop.
const MAX_NEW_TOKENS = 224;

/**
 * Transcribes one clip, showing Whisper the text that came just before it. Without that, a short
 * phrase after a pause has nothing to go on: "or no" alone reads as easily as "oh no".
 */
export async function transcribeWithContext(
  transcriber: AutomaticSpeechRecognitionPipeline,
  audio: Float32Array,
  language: string,
  context: string,
): Promise<string> {
  const { tokenizer, processor, model } = transcriber;
  const [previous, start, languageToken, transcribe, noTimestamps] =
    tokenizer.convert_tokens_to_ids([
      "<|startofprev|>",
      "<|startoftranscript|>",
      `<|${language}|>`,
      "<|transcribe|>",
      "<|notimestamps|>",
    ]) as number[];
  if (languageToken === undefined || languageToken === null) {
    throw new Error(`Language "${language}" is not supported.`);
  }
  const contextTokens = context.trim()
    ? (tokenizer.encode(` ${context.trim()}`, { add_special_tokens: false }) as number[]).slice(
        -MAX_PROMPT_TOKENS,
      )
    : [];
  const prefix = [
    ...(contextTokens.length > 0 ? [previous!, ...contextTokens] : []),
    start!,
    languageToken,
    transcribe!,
    noTimestamps!,
  ];
  const { input_features } = await processor(audio);
  const output = (await model.generate({
    inputs: input_features,
    decoder_input_ids: prefix,
    max_new_tokens: MAX_NEW_TOKENS,
  } as Parameters<typeof model.generate>[0])) as Tensor;
  const tokens = (output.tolist() as bigint[][])[0]!.slice(prefix.length).map(Number);
  return tokenizer.decode(tokens, { skip_special_tokens: true }).trim();
}
