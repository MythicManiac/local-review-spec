#!/usr/bin/env node
// Proves why SPEC 8 pins the change-set command. A user's git configuration can change which files
// `git diff --raw -M` reports, so two devices that run the plain command can disagree on file identity
// (path, oldPath, changeKey) and with it on file marks and file anchors. The pinned command
// (CHANGESET_GIT_ARGS in lib.mjs) is immune to that configuration.
//
// Three configuration and usage effects, each shown with a repository of one commit pair:
//   1. diff.renameLimit: above it git silently skips inexact rename detection, so renames with edits
//      come out as deletions plus additions. (Git's default is 1000; the test lowers it to stay fast.)
//   2. diff.ignoreSubmodules=all: a changed submodule pointer disappears from the output.
//   3. diff.relative=true: run from a subdirectory, git reports only that subdirectory's files, with paths
//      relative to it. No flag fixes that; the tool must run the command at the repository's top level.
//
//   node tools/changeset-experiment.mjs        (needs git on PATH; uses a temporary folder)

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { CHANGESET_GIT_ARGS } from "./lib.mjs";

const tmp = mkdtempSync(join(tmpdir(), "lrs-changeset-"));
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
const ID = ["-c", "user.name=T", "-c", "user.email=t@localhost", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always"];
const git = (cwd, ...args) => execFileSync("git", [...ID, ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const gitRaw = (cwd, args) => execFileSync("git", args, { cwd, env, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8");
const RENAMES = 10;

/** One repository: RENAMES files renamed (new basename) with an edit, and a submodule pointer moved. */
function build(name, config) {
  const sub = join(tmp, `${name}-sub`);
  mkdirSync(sub);
  git(sub, "init", "-q", "-b", "main");
  writeFileSync(join(sub, "s.txt"), "one\n");
  git(sub, "add", "-A");
  git(sub, "commit", "-q", "-m", "s1");

  const dir = join(tmp, name);
  mkdirSync(join(dir, "d"), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  for (const [k, v] of Object.entries(config)) git(dir, "config", "--local", k, v);
  for (let i = 0; i < RENAMES; i++) writeFileSync(join(dir, "d", `f${i}.txt`), Array.from({ length: 20 }, (_, k) => `line ${i}-${k} unique content of file ${i}`).join("\n") + "\n");
  git(dir, "submodule", "add", "-q", sub.replace(/\\/g, "/"), "sub");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");

  mkdirSync(join(dir, "e"));
  for (let i = 0; i < RENAMES; i++) {
    git(dir, "mv", `d/f${i}.txt`, `e/g${i}.txt`); // a new basename, so git cannot match it cheaply by name
    appendFileSync(join(dir, "e", `g${i}.txt`), `edited ${i}\n`);
  }
  writeFileSync(join(sub, "s.txt"), "one\ntwo\n");
  git(sub, "commit", "-q", "-am", "s2");
  git(join(dir, "sub"), "pull", "-q", "origin", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "rename with edits, move the submodule");
  return dir;
}

const summarize = (raw) => {
  const entries = raw.split("\0").filter((f) => f.startsWith(":"));
  const status = (letter) => entries.filter((e) => new RegExp(`^:\\d+ \\d+ \\w+ \\w+ ${letter}`).test(e)).length;
  return { renamed: status("R"), added: status("A"), deleted: status("D"), submodules: entries.filter((e) => e.startsWith(":160000") || e.includes(" 160000 ")).length };
};
const plain = (dir) => gitRaw(dir, ["diff", "--raw", "-z", "-M", "--no-abbrev", "--no-ext-diff", "HEAD~1", "HEAD", "--"]);
const pinned = (dir) => gitRaw(dir, [...CHANGESET_GIT_ARGS, "HEAD~1", "HEAD", "--"]);

let checks = 0;
const ok = (name) => {
  checks++;
  console.log(`ok  ${name}`);
};

try {
  // A developer's machine with settings that are all legitimate git configuration.
  const quirky = build("quirky", { "diff.renameLimit": "3", "diff.ignoreSubmodules": "all", "diff.renames": "false" });
  const stock = build("stock", {});

  const p1 = summarize(plain(quirky));
  const p2 = summarize(plain(stock));
  assert.deepEqual(p2, { renamed: RENAMES, added: 0, deleted: 0, submodules: 1 }, "stock configuration: the renames and the submodule are reported");
  assert.equal(p1.renamed, 0, "with a low rename limit, plain -M reports no renames");
  assert.equal(p1.added, RENAMES);
  assert.equal(p1.deleted, RENAMES);
  assert.equal(p1.submodules, 0, "with diff.ignoreSubmodules=all, plain -M hides the submodule change");
  ok("1. the plain command gives different change sets on two machines with different git configuration");

  const q1 = pinned(quirky);
  const q2 = pinned(stock);
  assert.deepEqual(summarize(q1), { renamed: RENAMES, added: 0, deleted: 0, submodules: 1 });
  assert.deepEqual(summarize(q2), { renamed: RENAMES, added: 0, deleted: 0, submodules: 1 });
  ok("2. the pinned command reports the renames and the submodule on both");

  // The two repositories hold the same files; only the submodule's commit ids differ, so mask object ids.
  const masked = (raw) => raw.replace(/[0-9a-f]{40}/g, "#");
  assert.equal(masked(q1), masked(q2), "same entries, same order, same paths");
  ok("3. and the two outputs describe the same files in the same order");

  // Where git runs matters too: with diff.relative=true, git run from a subdirectory reports only that
  // subdirectory's files, with paths relative to it. No flag of the command fixes that (SPEC 8 therefore
  // requires the repository's top level as working directory), so show both halves.
  git(stock, "config", "--local", "diff.relative", "true");
  assert.equal(masked(pinned(stock)), masked(q2), "at the top level the setting changes nothing");
  const inSubdirectory = masked(gitRaw(join(stock, "e"), [...CHANGESET_GIT_ARGS, "HEAD~1", "HEAD", "--"]));
  assert.notEqual(inSubdirectory, masked(q2), "from a subdirectory the change set differs");
  assert.ok(!inSubdirectory.includes("e/g0.txt") && inSubdirectory.includes("g0.txt"), "paths are relative to the subdirectory, not to the top level");
  ok("4. run at the top level the pinned command is immune to diff.relative; run from a subdirectory it is not");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`${checks} checks passed`);
