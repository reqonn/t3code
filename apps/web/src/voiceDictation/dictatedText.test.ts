import { describe, expect, it } from "vite-plus/test";

import { normalizeDictatedText } from "./dictatedText";

describe("normalizeDictatedText", () => {
  it.each([
    ["  Fix the login bug. ", "Fix the login bug."],
    ["[BLANK_AUDIO]", ""],
    [" (silence) [Music] ", ""],
    ["Wrap it (like this) please", "Wrap it (like this) please"],
  ])("normalizes %j", (input, expected) => {
    expect(normalizeDictatedText(input)).toBe(expected);
  });
});
