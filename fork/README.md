# T3 Code with voice dictation

This fork is [T3 Code](https://github.com/pingdotgg/t3code) plus voice dictation in the chat
composer: click the microphone next to the attach button, or press `Ctrl+Shift+D`.

## Updates are automatic

Every six hours, [Dictation release](../.github/workflows/dictation-release.yml) checks for a new
stable T3 Code release. When there is one, it applies dictation on top, builds the Windows
installer, and publishes it under [Releases](../../../releases). The installed app finds it through
its normal **Check for updates**.

If dictation no longer applies cleanly to a new T3 Code release, the build stops and opens an
issue in this repository. The installed app stays on its current version until it is fixed.

To build again by hand, open **Actions → Dictation release → Run workflow**.

## How the pieces fit

- `main` is upstream T3 Code at the commit this fork started from, plus the dictation commit and
  this `fork/` folder. Its difference from upstream is the feature.
- [`apply-dictation.mjs`](./apply-dictation.mjs) re-applies that difference to each new release:
  code through a three-way merge, config files by re-adding their entries.
- Releases are versioned `<T3 Code version>-dictation.<n>`, so the app still reports the same
  core version as official servers it connects to.
