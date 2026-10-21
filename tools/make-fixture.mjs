#!/usr/bin/env node
// Builds the small reviewed repository the example state refers to, with fixed dates, names and
// contents so the commit ids are the same on every machine, then exports what an implementation
// needs to run the example without git:
//
//   examples/content/commits.json      branch name -> commit id
//   examples/content/changesets.json   "<baseSha>..<headSha>" -> changed files with modes and blob ids
//   examples/content/blobs/<blob id>   the raw bytes of every blob a changeset mentions
//   examples/content/fixture.bundle    the repository itself, for tests that want real git
//
// Usage: node tools/make-fixture.mjs        (needs git on PATH; run from the repository root)

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { CHANGESET_GIT_ARGS } from "./lib.mjs";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "examples", "content");

const repo = mkdtempSync(join(tmpdir(), "lrs-fixture-"));
const git = (...args) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", env: gitEnv() }).trim();
let clock = Date.UTC(2026, 9, 14, 12, 0, 0) / 1000;
function gitEnv() {
  const date = `${clock} +0000`;
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@localhost",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@localhost",
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}
const write = (path, content) => {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
};
const commit = (message) => {
  clock += 3600;
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
};
const lines = (...l) => l.join("\n") + "\n";

git("init", "-q", "-b", "master");
git("config", "core.autocrlf", "false");

// ---- master: the base ---------------------------------------------------------------------
write("README.md", lines("# Calc demo", "A tiny calculator.", "Run tests with npm test."));
write(
  "src/calc.ts",
  lines(
    "export function add(a: number, b: number): number {",
    "  return a + b;",
    "}",
    "",
    "export function sub(a: number, b: number): number {",
    "  return a - b;",
    "}",
    "",
    'export const VERSION = "1.0";',
    "export const DEBUG = false;",
  ),
);
write("src/legacy.ts", lines("export const legacy = true;", "export function oldHelper() {", "  return 1;", "}"));
write(
  "src/util_old.ts",
  lines(
    "export function clamp(n: number, lo: number, hi: number): number {",
    "  return Math.min(Math.max(n, lo), hi);",
    "}",
    "",
    "export function noop() {}",
  ),
);
mkdirSync(join(repo, "assets"), { recursive: true });
writeFileSync(join(repo, "assets", "logo.bin"), Buffer.from([0x89, 0x4c, 0x52, 0x00, 0x01, 0x02, 0x03, 0x04]));
const master = commit("Base calculator");

// ---- feature/calc, round one --------------------------------------------------------------
git("checkout", "-q", "-b", "feature/calc");
write("README.md", lines("# Calc demo", "A tiny calculator.", "Run tests with `pnpm test`.", "See the docs for more."));
write(
  "src/calc.ts",
  lines(
    "export function add(a: number, b: number): number {",
    "  return a + b;",
    "}",
    "",
    "export function sub(a: number, b: number): number {",
    "  return a - b;",
    "}",
    "",
    "export function mul(a: number, b: number): number {",
    "  return a * b;",
    "}",
    "",
    "export function div(a: number, b: number): number {",
    "  return a / b;",
    "}",
    "",
    'export const VERSION = "1.1";',
    "export const DEBUG = false;",
  ),
);
rmSync(join(repo, "src", "legacy.ts"));
rmSync(join(repo, "src", "util_old.ts"));
write(
  "src/util.ts",
  lines(
    "export function clamp(n: number, lo: number, hi: number): number {",
    "  return Math.min(Math.max(n, lo), hi);",
    "}",
    "",
    "export function noop() {}",
    'export const ID = "util";',
  ),
);
write("src/extra.ts", lines("export function twice(f: () => void) {", "  f();", "  f();", "}"));
writeFileSync(join(repo, "assets", "logo.bin"), Buffer.from([0x89, 0x4c, 0x52, 0x00, 0x09, 0x08, 0x07, 0x06]));
const c1 = commit("Add mul and div, rename util, drop legacy");

// ---- feature/calc, round two (what the reviewer asked for, plus a header) -----------------
write(
  "src/calc.ts",
  lines(
    "// Calculator functions.",
    "",
    "export function add(a: number, b: number): number {",
    "  return a + b;",
    "}",
    "",
    "export function sub(a: number, b: number): number {",
    "  return a - b;",
    "}",
    "",
    "export function mul(a: number, b: number): number {",
    "  return a * b;",
    "}",
    "",
    "export function div(a: number, b: number): number {",
    '  if (b === 0) throw new Error("division by zero");',
    "  return a / b;",
    "}",
    "",
    'export const VERSION = "1.1";',
    "export const DEBUG = false;",
  ),
);
const c2 = commit("Address review: guard division, add header");

// ---- export -------------------------------------------------------------------------------
function changeset(base, head) {
  const raw = execFileSync("git", [...CHANGESET_GIT_ARGS, base, head, "--"], {
    cwd: repo,
    env: gitEnv(),
  }).toString("utf8");
  const fields = raw.split("\0");
  const files = [];
  for (let i = 0; i < fields.length; ) {
    const meta = fields[i++];
    if (!meta) continue;
    const [oldMode, newMode, oldBlob, newBlob, code] = meta.slice(1).split(" ");
    const letter = code[0];
    let oldPath = null;
    let path;
    if (letter === "R" || letter === "C") {
      oldPath = fields[i++];
      path = fields[i++];
    } else {
      path = fields[i++];
    }
    const status = { A: "added", D: "deleted", R: "renamed", C: "copied", T: "typeChanged" }[letter] ?? "modified";
    // `path` is the file's identity in the diff: the new path, or the old one for a deletion.
    files.push({
      path,
      oldPath: oldPath ?? null,
      status,
      oldMode,
      newMode,
      oldBlob,
      newBlob,
    });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "blobs"), { recursive: true });
const sets = {
  [`${master}..${c1}`]: changeset(master, c1),
  [`${master}..${c2}`]: changeset(master, c2),
};
const zero = /^0+$/;
for (const files of Object.values(sets)) {
  for (const f of files) {
    for (const blob of [f.oldBlob, f.newBlob]) {
      if (zero.test(blob)) continue;
      const bytes = execFileSync("git", ["cat-file", "blob", blob], { cwd: repo, env: gitEnv() });
      writeFileSync(join(out, "blobs", blob), bytes);
    }
  }
}
writeFileSync(join(out, "commits.json"), JSON.stringify({ master, "feature/calc@1": c1, "feature/calc@2": c2 }, null, 2) + "\n");
writeFileSync(join(out, "changesets.json"), JSON.stringify(sets, null, 2) + "\n");
const bundle = join(tmpdir(), "lrs-fixture.bundle");
git("bundle", "create", bundle, "--all");
copyFileSync(bundle, join(out, "fixture.bundle"));
rmSync(bundle);
rmSync(repo, { recursive: true, force: true });
console.log(readFileSync(join(out, "commits.json"), "utf8"));
