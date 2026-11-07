import { describe, expect, it } from "vite-plus/test";

import { spokenSummary } from "./spokenSummary";

describe("spokenSummary", () => {
  it("reads the first two sentences of the first paragraph", () => {
    expect(
      spokenSummary("Fixed the login bug. Tests pass. Also renamed a file.\n\nMore detail here."),
    ).toBe("Fixed the login bug. Tests pass.");
  });

  it("skips headings, tables and code", () => {
    expect(
      spokenSummary("# Summary\n\n```ts\nconst a = 1;\n```\n\n| a | b |\n\nThe build works now."),
    ).toBe("The build works now.");
  });

  it("drops markdown, links and file paths", () => {
    expect(
      spokenSummary("Updated **the** [settings page](https://x.dev) in `src/settings.tsx` today."),
    ).toBe("Updated the settings page in today.");
  });

  it("keeps a paragraph without sentence endings", () => {
    expect(spokenSummary("All done")).toBe("All done");
  });

  it("caps very long text", () => {
    expect(spokenSummary(`${"word ".repeat(200)}.`).length).toBeLessThanOrEqual(320);
  });
});
