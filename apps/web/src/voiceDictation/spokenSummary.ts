const MAX_SENTENCES = 2;
const MAX_CHARS = 320;

/**
 * The part of a reply worth reading aloud: its first paragraph of prose, two sentences at most,
 * without code, markdown, or file paths.
 */
export function spokenSummary(reply: string): string {
  const withoutCode = reply.replace(/```[\s\S]*?```/g, "");
  const paragraph =
    withoutCode
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .find((part) => part.length > 0 && !/^(#|\||-{3})/.test(part)) ?? "";
  const plain = paragraph
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/[*_#>]/g, "")
    .replace(/\b[a-z]:\\\S+|\S+\.(?:tsx?|jsx?|mjs|py|json|md|png|ps1|css|html)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = plain.match(/[^.!?]+[.!?]+/g);
  const text = sentences
    ? sentences
        .slice(0, MAX_SENTENCES)
        .map((sentence) => sentence.trim())
        .join(" ")
    : plain;
  return text.slice(0, MAX_CHARS);
}
