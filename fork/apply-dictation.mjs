#!/usr/bin/env node
// Re-applies this fork's changes to the T3 Code checkout in the cwd. Code goes through a 3-way
// merge so conflicting upstream edits stop the build; config files change too often for that, so
// their additions are re-inserted and pnpm-lock.yaml is left for `pnpm install` to regenerate.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...value] = arg.replace(/^--/, "").split("=");
    return [key, value.join("=")];
  }),
);
const { base, feature } = args;
if (!base || !feature) {
  console.error("Usage: apply-dictation.mjs --base=<sha> --feature=<sha>");
  process.exit(2);
}

const WORKSPACE = "pnpm-workspace.yaml";
const WEB_PACKAGE = "apps/web/package.json";
const LICENSES = "third-party-licenses.config.json";
const NOT_APPLIED = [
  "pnpm-lock.yaml",
  WORKSPACE,
  WEB_PACKAGE,
  LICENSES,
  "fork",
  ".github",
  "README.md",
];

const git = (...gitArgs) =>
  NodeChildProcess.execFileSync("git", gitArgs, { encoding: "utf8", maxBuffer: 1024 * 1024 * 512 });
const show = (commit, path) => git("show", `${commit}:${path}`);

function applyCodeChanges() {
  const patch = git(
    "diff",
    "--binary",
    base,
    feature,
    "--",
    ".",
    ...NOT_APPLIED.map((path) => `:(exclude)${path}`),
  );
  if (patch.trim().length === 0) return;
  const patchFile = NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "dictation-")),
    "feature.patch",
  );
  NodeFS.writeFileSync(patchFile, patch);
  NodeChildProcess.execFileSync("git", ["apply", "--3way", "--whitespace=nowarn", patchFile], {
    stdio: "inherit",
  });
}

function applyWebDependencies() {
  const before = JSON.parse(show(base, WEB_PACKAGE));
  const after = JSON.parse(show(feature, WEB_PACKAGE));
  const target = JSON.parse(NodeFS.readFileSync(WEB_PACKAGE, "utf8"));
  for (const field of ["dependencies", "devDependencies"]) {
    for (const [name, version] of Object.entries(after[field] ?? {})) {
      if (before[field]?.[name] === version) continue;
      target[field] = { ...target[field], [name]: version };
    }
    target[field] = Object.fromEntries(
      Object.entries(target[field] ?? {}).toSorted(([a], [b]) => a.localeCompare(b)),
    );
  }
  NodeFS.writeFileSync(WEB_PACKAGE, `${JSON.stringify(target, null, 2)}\n`);
}

function applyLicenseOverrides() {
  const key = (entry) => `${entry.name ?? entry.repositoryUrl}@${entry.version ?? ""}`;
  const before = new Set(JSON.parse(show(base, LICENSES)).packageOverrides.map(key));
  const added = JSON.parse(show(feature, LICENSES)).packageOverrides.filter(
    (entry) => !before.has(key(entry)),
  );
  const target = JSON.parse(NodeFS.readFileSync(LICENSES, "utf8"));
  const present = new Set(target.packageOverrides.map(key));
  for (const entry of added) if (!present.has(key(entry))) target.packageOverrides.push(entry);
  NodeFS.writeFileSync(LICENSES, `${JSON.stringify(target, null, 2)}\n`);
}

// Inserts each block of lines the fork added to pnpm-workspace.yaml right under the same
// top-level section (allowBuilds:, overrides:, patchedDependencies:) of the upstream file.
function applyWorkspaceAdditions() {
  const featureLines = show(feature, WORKSPACE).split("\n");
  const diff = git("diff", "-U0", base, feature, "--", WORKSPACE);
  const blocks = [];
  for (const hunk of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(hunk[1]) - 1;
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count > 0) blocks.push(featureLines.slice(start, start + count));
  }
  let target = NodeFS.readFileSync(WORKSPACE, "utf8").split("\n");
  for (const block of blocks) {
    const firstEntry = block.find((line) => !line.trim().startsWith("#"));
    if (firstEntry && target.includes(firstEntry)) continue;
    const blockStart = featureLines.indexOf(block[0]);
    const section = featureLines
      .slice(0, blockStart)
      .findLast((line) => /^[A-Za-z][\w-]*:\s*$/.test(line));
    const sectionIndex = section ? target.indexOf(section) : -1;
    if (sectionIndex === -1) {
      throw new Error(`${WORKSPACE} has no "${section}" section for: ${block.join(" | ")}`);
    }
    target = [...target.slice(0, sectionIndex + 1), ...block, ...target.slice(sectionIndex + 1)];
  }
  NodeFS.writeFileSync(WORKSPACE, target.join("\n"));
}

applyCodeChanges();
applyWebDependencies();
applyLicenseOverrides();
applyWorkspaceAdditions();
console.log("Applied the fork's changes.");
